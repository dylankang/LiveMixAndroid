package com.livemix.g2;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * 분석 중에만 켜지는 포그라운드 서비스 (알림 표시).
 * - 마이크(+미디어 재생) 타입 포그라운드 서비스: 화면이 꺼지거나 Even 앱이 앞에 있어도 마이크 입력과 앱 프로세스를 유지
 * - PARTIAL_WAKE_LOCK: 화면이 꺼져도 CPU 유지 → WebView 의 분석 루프·MQTT 전송이 멈추지 않음
 * - Wi-Fi 고성능 락: 화면 꺼짐 중 Wi-Fi 절전으로 브로커 연결이 끊기는 것 방지
 */
public class KeepAliveService extends Service {
    private static final String TAG = "LiveMixKeepAlive";
    private static final String CHANNEL = "analysis";
    private static final int NOTIF_ID = 1001;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context c) {
        try {
            c.startForegroundService(new Intent(c, KeepAliveService.class));
        } catch (Exception e) {
            Log.w(TAG, "포그라운드 서비스 시작 실패", e);
        }
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

    @SuppressWarnings("deprecation")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Live Mix Assistant 분석 중")
                .setContentText("화면이 꺼지거나 다른 앱을 열어도 분석과 G2 HUD 전송을 계속합니다")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                // 마이크 입력 분석: microphone 타입 / 레퍼런스 플레이어만 쓰는 경우(마이크 권한 없음): mediaPlayback 타입
                boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                        | (mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
                startForeground(NOTIF_ID, n, type);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            Log.w(TAG, "startForeground 실패", e);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LiveMix:analysis");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(6 * 60 * 60 * 1000L);   // 최대 6시간 (공연 한 회차 기준), 정지 시 바로 해제
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LiveMix:mqtt");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
