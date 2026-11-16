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
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaRecorder;
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
    static final String ACTION_INPUT_START = "input_start";
    static final String EXTRA_DEVICE = "device";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";
    static final int RATE = 48000;

    /** 캡처한 PCM·상태를 받는 곳 (MainActivity 가 등록) */
    interface Sink {
        void onPcm(String base64);
        /** state: started / denied / error / stopped · started 일 때 rate·channels(실제 장치 채널)·label */
        void onMediaState(String state, String msg, int rate, int channels, String label);
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
            if (s != null) s.onMediaState("error", String.valueOf(e.getMessage()), 0, 0, null);
        }
    }

    /**
     * 🎛️ 오디오 입력(USB 오디오 인터페이스 등)을 안드로이드 AudioRecord 로 직접 스테레오 캡처.
     * 웹(Chromium/WebView)의 getUserMedia 는 안드로이드에서 입력을 모노로 고정해 열기 때문에(Chromium 기본값),
     * 2채널 장치도 L/R 이 합쳐진다 → 앱에서는 네이티브로 열어 L/R 을 그대로 받는다.
     */
    public static void startInput(Context c, int deviceId) {
        try {
            c.startForegroundService(new Intent(c, KeepAliveService.class).setAction(ACTION_INPUT_START).putExtra(EXTRA_DEVICE, deviceId));
        } catch (Exception e) {
            Log.w(TAG, "입력 캡처 서비스 시작 실패", e);
            Sink s = sink;
            if (s != null) s.onMediaState("error", String.valueOf(e.getMessage()), 0, 0, null);
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
        if (ACTION_INPUT_START.equals(action)) {
            mediaMode = false;
            if (!goForeground(false)) {
                emitState("error", "포그라운드 서비스를 시작하지 못했습니다");
                return START_NOT_STICKY;
            }
            startInputCapture(intent.getIntExtra(EXTRA_DEVICE, -1));
            acquireLocks();
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
            reader = new Thread(() -> readLoop(rec, 2, RATE), "livemix-capture");
            reader.setPriority(Thread.MAX_PRIORITY);
            reader.start();
            emitStarted(RATE, 2, "📱 휴대폰 미디어 출력 (볼륨 전단)");
        } catch (Exception e) {
            Log.w(TAG, "미디어 캡처 실패", e);
            emitState("error", String.valueOf(e.getMessage()));
            stopCapture();
        }
    }

    // ───────── 🎛️ 오디오 입력 직접 캡처 (USB 오디오 인터페이스 · 스테레오) ─────────
    @SuppressLint("MissingPermission")
    private void startInputCapture(int deviceId) {
        stopCapture();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            emitState("error", "마이크(오디오 녹음) 권한이 필요합니다"); return;
        }
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            AudioDeviceInfo dev = null;
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) if (d.getId() == deviceId) dev = d;
            if (dev == null && deviceId != -1) { emitState("error", "선택한 입력 장치가 연결되어 있지 않습니다 (USB 를 다시 꽂고 [장치 찾기])"); return; }
            // 샘플레이트: 48kHz 우선 (장치가 지원 목록을 알려 주면 그 안에서)
            int rate = 48000;
            int[] rates = dev != null ? dev.getSampleRates() : new int[0];
            if (rates.length > 0) {
                boolean has48 = false;
                for (int r : rates) if (r == 48000) has48 = true;
                if (!has48) { rate = rates[0]; for (int r : rates) if (r > rate && r <= 48000) rate = r; }
            }
            // 원음 그대로: UNPROCESSED(지원 시) → VOICE_RECOGNITION(대부분 AGC/NS 없음) 순
            String unp = am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED);
            int[] sources = "true".equals(unp)
                    ? new int[]{MediaRecorder.AudioSource.UNPROCESSED, MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC}
                    : new int[]{MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC};
            // 채널: 항상 스테레오를 먼저 요청, 장치가 못 하면 모노
            int[] masks = {AudioFormat.CHANNEL_IN_STEREO, AudioFormat.CHANNEL_IN_MONO};
            AudioRecord rec = null;
            String srcName = "";
            outer:
            for (int mask : masks) {
                for (int src : sources) {
                    try {
                        int min = AudioRecord.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT);
                        if (min <= 0) continue;
                        AudioRecord r = new AudioRecord.Builder()
                                .setAudioSource(src)
                                .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(mask).build())
                                .setBufferSizeInBytes(Math.max(min * 4, rate * 4 / 2))
                                .build();
                        if (r.getState() != AudioRecord.STATE_INITIALIZED) { r.release(); continue; }
                        if (dev != null) r.setPreferredDevice(dev);
                        rec = r;
                        srcName = src == MediaRecorder.AudioSource.UNPROCESSED ? "UNPROCESSED" : src == MediaRecorder.AudioSource.VOICE_RECOGNITION ? "VOICE_RECOGNITION" : "MIC";
                        break outer;
                    } catch (Exception ignored) { }
                }
            }
            if (rec == null) { emitState("error", "이 장치를 AudioRecord 로 열지 못했습니다"); return; }
            recorder = rec;
            rec.startRecording();
            int ch = rec.getChannelCount();
            AudioDeviceInfo routed = rec.getRoutedDevice();
            String name = routed != null ? String.valueOf(routed.getProductName()) : dev != null ? String.valueOf(dev.getProductName()) : "기본 입력";
            capturing = true;
            final int fch = ch, frate = rec.getSampleRate();
            final AudioRecord frec = rec;
            reader = new Thread(() -> readLoop(frec, fch, frate), "livemix-input");
            reader.setPriority(Thread.MAX_PRIORITY);
            reader.start();
            emitStarted(frate, ch, "🎛️ " + name + " · 네이티브 " + (ch >= 2 ? "스테레오" : "모노") + " (" + srcName + ")");
        } catch (Exception e) {
            Log.w(TAG, "입력 캡처 실패", e);
            emitState("error", String.valueOf(e.getMessage()));
            stopCapture();
        }
    }

    /** 100ms 씩 읽어 16-bit 스테레오 인터리브(L,R)로 Base64 → WebView. 모노 장치면 L=R 로 복제 */
    private void readLoop(AudioRecord rec, int channels, int rate) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        final int frameBytes = channels >= 2 ? 4 : 2;
        final int chunk = rate / 10 * frameBytes;
        byte[] buf = new byte[chunk];
        byte[] st = channels >= 2 ? null : new byte[chunk * 2];
        while (capturing) {
            int off = 0;
            while (off < chunk && capturing) {
                int r = rec.read(buf, off, chunk - off);
                if (r <= 0) { if (r < 0) { capturing = false; } break; }
                off += r;
            }
            off -= off % frameBytes;
            if (off <= 0) continue;
            Sink s = sink;
            if (s == null) continue;
            if (st == null) s.onPcm(Base64.encodeToString(buf, 0, off, Base64.NO_WRAP));
            else {
                for (int i = 0, o = 0; i < off; i += 2, o += 4) { st[o] = buf[i]; st[o + 1] = buf[i + 1]; st[o + 2] = buf[i]; st[o + 3] = buf[i + 1]; }
                s.onPcm(Base64.encodeToString(st, 0, off * 2, Base64.NO_WRAP));
            }
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
        if (s != null) s.onMediaState(state, msg, 0, 0, null);
    }

    private void emitStarted(int rate, int channels, String label) {
        Sink s = sink;
        if (s != null) s.onMediaState("started", null, rate, channels, label);
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
