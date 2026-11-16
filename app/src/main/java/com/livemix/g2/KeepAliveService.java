package com.livemix.g2;

import android.Manifest;
import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.util.Base64;
import android.util.Log;

/**
 * 분석 중에만 켜지는 포그라운드 서비스 (알림 표시).
 * - 포그라운드 서비스 + PARTIAL_WAKE_LOCK + Wi-Fi 고성능 락: 화면이 꺼지거나 다른 앱(Even 앱 등)이 앞에 있어도
 *   앱 프로세스·CPU·네트워크를 유지 → WebView 의 분석 루프, AI 호출, 수신기 전송이 멈추지 않음
 * - 📱 휴대폰 미디어 출력 캡처(안드로이드 10+): MediaProjection + AudioPlaybackCapture 로 다른 앱에서 재생 중인 소리를
 *   48kHz 16-bit 스테레오로 받아 WebView 로 넘긴다. 이 캡처 경로는 외부 정책 믹스(remote submix)라 시스템 미디어 볼륨과
 *   무관하게 단위 이득(볼륨 전단)으로 들어온다 → 폰 볼륨을 줄이거나 꺼도 분석 레벨은 그대로.
 */
public class KeepAliveService extends Service {
    private static final String TAG = "LiveMixKeepAlive";
    private static final String CHANNEL = "analysis";
    private static final int NOTIF_ID = 1001;
    static final String ACTION_KEEP = "keep";
    static final String ACTION_MEDIA_START = "media_start";
    static final String ACTION_MEDIA_STOP = "media_stop";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";
    static final int RATE = 48000;

    /** 캡처한 PCM·상태를 받는 곳 (MainActivity 가 등록) */
    interface Sink {
        void onPcm(String base64);
        void onMediaState(String state, String msg);
    }
    static volatile Sink sink;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private MediaProjection projection;
    private MediaProjection.Callback projectionCb;
    private AudioRecord recorder;
    private Thread reader;
    private volatile boolean capturing;
    private boolean mediaMode;
    private final Handler main = new Handler(Looper.getMainLooper());

    public static void start(Context c) {
        try {
            c.startForegroundService(new Intent(c, KeepAliveService.class).setAction(ACTION_KEEP));
        } catch (Exception e) {
            Log.w(TAG, "포그라운드 서비스 시작 실패", e);
        }
    }

    /** 화면 녹화(미디어 캡처) 동의 결과로 미디어 출력 캡처 시작 */
    public static void startMedia(Context c, int resultCode, Intent data) {
        try {
            c.startForegroundService(new Intent(c, KeepAliveService.class).setAction(ACTION_MEDIA_START)
                    .putExtra(EXTRA_CODE, resultCode).putExtra(EXTRA_DATA, data));
        } catch (Exception e) {
            Log.w(TAG, "미디어 캡처 서비스 시작 실패", e);
            Sink s = sink;
            if (s != null) s.onMediaState("error", String.valueOf(e.getMessage()));
        }
    }

    public static void stopMedia(Context c) {
        try { c.startService(new Intent(c, KeepAliveService.class).setAction(ACTION_MEDIA_STOP)); } catch (Exception ignored) { }
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, KeepAliveService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "실시간 분석", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("분석 중 표시 (화면이 꺼져도 분석을 유지하기 위해 필요)");
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle(mediaMode ? "Live Mix Assistant · 휴대폰 미디어 분석 중" : "Live Mix Assistant 분석 중")
                .setContentText("화면이 꺼지거나 다른 앱을 열어도 분석과 G2 HUD 전송을 계속합니다")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private boolean goForeground(boolean withProjection) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
                if (Build.VERSION.SDK_INT >= 30 && mic) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (withProjection) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
                startForeground(NOTIF_ID, buildNotification(), type);
            } else {
                startForeground(NOTIF_ID, buildNotification());
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground 실패", e);
            return false;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_KEEP;
        if (ACTION_MEDIA_STOP.equals(action)) {
            stopCapture();
            mediaMode = false;
            goForeground(false);
            return START_NOT_STICKY;
        }
        if (ACTION_MEDIA_START.equals(action)) {
            mediaMode = true;
            if (!goForeground(true)) {      // 안드로이드 10+: mediaProjection 타입 포그라운드 서비스가 먼저 떠 있어야 함
                emitState("error", "포그라운드 서비스를 시작하지 못했습니다");
                mediaMode = false;
                return START_NOT_STICKY;
            }
            int code = intent.getIntExtra(EXTRA_CODE, Activity.RESULT_CANCELED);
            Intent data = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(EXTRA_DATA, Intent.class) : legacyData(intent);
            if (Build.VERSION.SDK_INT >= 29) startCapture(code, data);
            else emitState("error", "안드로이드 10 이상에서만 지원됩니다");
        } else if (!goForeground(mediaMode)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private static Intent legacyData(Intent i) { return i.getParcelableExtra(EXTRA_DATA); }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LiveMix:analysis");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(8 * 60 * 60 * 1000L);   // 최대 8시간 (공연 한 회차 기준), 정지 시 바로 해제
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LiveMix:net");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    // ───────── 📱 미디어 출력 캡처 (AudioPlaybackCapture) ─────────
    @SuppressLint("MissingPermission")
    @TargetApi(29)
    private void startCapture(int resultCode, Intent data) {
        stopCapture();
        if (Build.VERSION.SDK_INT < 29) { emitState("error", "안드로이드 10 이상에서만 지원됩니다"); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            emitState("error", "마이크(오디오 녹음) 권한이 필요합니다"); return;
        }
        if (resultCode != Activity.RESULT_OK || data == null) { emitState("denied", null); return; }
        try {
            MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
            projection = mpm.getMediaProjection(resultCode, data);
            if (projection == null) { emitState("error", "MediaProjection 을 받지 못했습니다"); return; }
            projectionCb = new MediaProjection.Callback() {
                @Override public void onStop() {   // 사용자가 빠른 설정·알림 등에서 공유를 중지함
                    main.post(() -> { stopCapture(); emitState("stopped", "미디어 캡처가 중지되었습니다"); });
                }
            };
            projection.registerCallback(projectionCb, main);

            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .excludeUid(Process.myUid())          // 이 앱 자신의 소리(모니터링)는 다시 받지 않음
                    .build();
            AudioFormat fmt = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord.Builder()
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(Math.max(min * 4, RATE * 4 / 2))   // 0.5초
                    .setAudioPlaybackCaptureConfig(cfg)
                    .build();
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) { emitState("error", "AudioRecord 초기화 실패"); stopCapture(); return; }
            recorder.startRecording();
            capturing = true;
            final AudioRecord rec = recorder;
            reader = new Thread(() -> readLoop(rec), "livemix-capture");
            reader.setPriority(Thread.MAX_PRIORITY);
            reader.start();
            emitState("started", null);
        } catch (Exception e) {
            Log.w(TAG, "미디어 캡처 실패", e);
            emitState("error", String.valueOf(e.getMessage()));
            stopCapture();
        }
    }

    /** 100ms(4800프레임 × 2채널 × 16bit = 19,200바이트)씩 읽어 Base64 로 WebView 에 전달 */
    private void readLoop(AudioRecord rec) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        final int chunk = RATE / 10 * 4;
        byte[] buf = new byte[chunk];
        while (capturing) {
            int off = 0;
            while (off < chunk && capturing) {
                int r = rec.read(buf, off, chunk - off);
                if (r <= 0) { if (r < 0) { capturing = false; } break; }
                off += r;
            }
            if (off <= 0) continue;
            Sink s = sink;
            if (s != null) s.onPcm(Base64.encodeToString(buf, 0, off - (off % 4), Base64.NO_WRAP));
        }
    }

    private void stopCapture() {
        capturing = false;
        if (recorder != null) {
            try { recorder.stop(); } catch (Exception ignored) { }
            try { recorder.release(); } catch (Exception ignored) { }
            recorder = null;
        }
        if (reader != null) { try { reader.join(300); } catch (InterruptedException ignored) { } reader = null; }
        if (projection != null) {
            if (projectionCb != null) { try { projection.unregisterCallback(projectionCb); } catch (Exception ignored) { } }
            try { projection.stop(); } catch (Exception ignored) { }
            projection = null;
        }
        projectionCb = null;
    }

    private void emitState(String state, String msg) {
        Sink s = sink;
        if (s != null) s.onMediaState(state, msg);
    }

    @Override
    public void onDestroy() {
        stopCapture();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
