package com.livemix.g2;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Live Mix Assistant 안드로이드 앱.
 * - 📱 휴대폰 미디어 출력 캡처: 입력 목록의 '휴대폰 미디어 출력' → 화면 녹화(미디어 캡처) 동의 → KeepAliveService 가
 *   다른 앱에서 재생 중인 소리를 볼륨 전단에서 받아 window.__lmPcm(base64) 로 계속 넘김
 * - 📱 같은 폰 자동 연결: 분석기가 보낸 메시지를 LocalServer(127.0.0.1)에 보관 → 같은 폰 Even 앱의 수신기가 코드 없이 가져감
 * - 웹앱(분석기)이 APK 안(assets/www)에 포함되어 인터넷 서버(Netlify) 없이 단독으로 동작
 * - 웹이 [시작]을 누르면 LiveMixNative.setRunning(true) 를 호출 → 포그라운드 서비스로 화면이 꺼져도/다른 앱을 열어도 분석 유지
 * - 크롬과 달리 앱은 WebView 를 일시정지시키지 않는다 (onPause 에서 webView.onPause()/pauseTimers() 를 호출하지 않음)
 */
public class MainActivity extends Activity {
    private static final String PREFS = "livemix";
        private static final String KEY_BATTERY_ASKED = "batteryAsked";
    private static final int REQ_AUDIO = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int REQ_FILE = 3;
    private static final int REQ_PROJECTION = 4;
    private static final int REQ_AUDIO_MEDIA = 5;
    private static final int MENU_RECEIVER = 1, MENU_RELOAD = 2, MENU_BATTERY = 3, MENU_EXIT = 4;

    private WebView webView;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> fileCallback;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean analyzing = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // localStorage (API 키·설정 저장)
        s.setMediaPlaybackRequiresUserGesture(false); // 레퍼런스 플레이어·오디오 엔진 자동 재생
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 화면이 꺼지거나 다른 앱이 앞에 있어도 렌더러 우선순위를 낮추지 않음 → 분석·전송 유지
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        webView.setKeepScreenOn(false);

        webView.addJavascriptInterface(new NativeBridge(), "LiveMixNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!"https".equals(u.getScheme()) || !WebAssets.HOST.equals(u.getHost())) return null;   // 외부(AI API·MQTT 등)는 그대로 인터넷
                String rel = WebAssets.resolve(u.getPath());
                try {
                    if (rel == null) throw new java.io.IOException("bad path");
                    InputStream in = WebAssets.open(MainActivity.this, rel);
                    String mime = WebAssets.mime(rel);
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-cache");
                    return new WebResourceResponse(mime, WebAssets.isText(mime) ? "utf-8" : null, 200, "OK", h, in);
                } catch (java.io.IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(),
                            new java.io.ByteArrayInputStream("Not Found".getBytes()));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (WebAssets.HOST.equals(request.getUrl().getHost())) return false;   // 앱 내부 페이지는 앱 안에서
                try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) { }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                ui.post(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // 레퍼런스 플레이어의 [📂 파일 불러오기]
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "파일 선택 앱을 열 수 없습니다", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }

        // 📱 같은 폰 자동 연결: 폰 내부 서버(127.0.0.1)를 항상 켜 둔다 → 같은 폰 Even 앱의 수신기가 코드 없이 찾아옴
        LocalServer.ensureStarted(this);
        LocalServer.setInbound(json -> ui.post(() -> js("window.__lmLocalRx&&window.__lmLocalRx(" + JSONObject.quote(json) + ")")));
        // 📱 미디어 출력 캡처 PCM·상태 → WebView
        KeepAliveService.sink = new KeepAliveService.Sink() {
            @Override public void onPcm(String b64) { ui.post(() -> js("window.__lmPcm&&window.__lmPcm('" + b64 + "')")); }
            @Override public void onMediaState(String state, String msg) {
                ui.post(() -> {
                    try {
                        JSONObject o = new JSONObject().put("type", "media").put("state", state);
                        if ("started".equals(state)) o.put("rate", KeepAliveService.RATE).put("channels", 2);
                        if (msg != null) o.put("msg", msg);
                        emitEvent(o);
                    } catch (Exception ignored) { }
                });
            }
        };
        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(WebAssets.BASE);
    }

    private void js(String code) {
        if (webView != null) webView.evaluateJavascript(code, null);
    }

    private void emitEvent(JSONObject o) {
        js("window.__lmNativeEvent&&window.__lmNativeEvent(" + JSONObject.quote(o.toString()) + ")");
    }

    private void emitMedia(String state, String msg) {
        try {
            JSONObject o = new JSONObject().put("type", "media").put("state", state);
            if (msg != null) o.put("msg", msg);
            emitEvent(o);
        } catch (Exception ignored) { }
    }

    // ───────── 📱 미디어 출력 캡처 시작: 녹음 권한 → 화면 녹화(미디어 캡처) 동의 → 서비스 ─────────
    private void beginMediaCapture() {
        if (Build.VERSION.SDK_INT < 29) { emitMedia("error", "안드로이드 10 이상에서만 지원됩니다"); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO_MEDIA);
            return;
        }
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION);
        } catch (Exception e) {
            emitMedia("error", String.valueOf(e.getMessage()));
        }
    }

    // ───────── 웹 ↔ 앱 연결 ─────────
    private class NativeBridge {
        @JavascriptInterface
        public boolean isNative() { return true; }

        @JavascriptInterface
        public String appVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }

        /** 📱 휴대폰 미디어 출력 캡처 가능 여부 (안드로이드 10+) */
        @JavascriptInterface
        public boolean mediaCaptureSupported() { return Build.VERSION.SDK_INT >= 29; }

        @JavascriptInterface
        public void startMediaCapture() { ui.post(MainActivity.this::beginMediaCapture); }

        @JavascriptInterface
        public void stopMediaCapture() { ui.post(() -> KeepAliveService.stopMedia(MainActivity.this)); }

        /** 📱 같은 폰 자동 연결: 분석기 메시지를 폰 내부 서버에 보관 (수신기가 가져감) */
        @JavascriptInterface
        public void localPost(String topic, String json, boolean retain) { LocalServer.publish(topic, json, retain); }

        /** 웹 분석기의 [시작]/[정지]에서 호출 */
        @JavascriptInterface
        public void setRunning(final boolean running) {
            ui.post(() -> {
                analyzing = running;
                if (running) {
                    KeepAliveService.start(MainActivity.this);
                    askBatteryOnce();
                } else {
                    KeepAliveService.stop(MainActivity.this);
                }
            });
        }
    }

    // ───────── 마이크 권한: 웹의 getUserMedia → 안드로이드 RECORD_AUDIO ─────────
    private void handlePermission(PermissionRequest request) {
        List<String> grant = new ArrayList<>();
        boolean wantsAudio = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) { wantsAudio = true; grant.add(r); }
        }
        if (!wantsAudio) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(grant.toArray(new String[0]));
        } else {
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_AUDIO_MEDIA) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (ok) beginMediaCapture();
            else emitMedia("denied", "오디오 녹음 권한이 필요합니다");
            return;
        }
        if (requestCode != REQ_AUDIO || pendingPermission == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else {
            pendingPermission.deny();
            Toast.makeText(this, "마이크 권한이 없으면 오디오를 분석할 수 없습니다 (설정 → 앱 → 권한)", Toast.LENGTH_LONG).show();
        }
        pendingPermission = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PROJECTION) {
            if (resultCode == RESULT_OK && data != null) {
                analyzing = true;
                KeepAliveService.startMedia(this, resultCode, data);
                askBatteryOnce();
            } else emitMedia("denied", null);
            return;
        }
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    // ───────── 배터리 최적화 제외 (화면 꺼짐 중 네트워크/CPU 유지에 도움) ─────────
    private boolean ignoringBattery() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void askBatteryOnce() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (ignoringBattery() || p.getBoolean(KEY_BATTERY_ASKED, false)) return;
        p.edit().putBoolean(KEY_BATTERY_ASKED, true).apply();
        new AlertDialog.Builder(this)
                .setTitle("화면이 꺼져도 분석 유지")
                .setMessage("화면이 꺼진 동안·다른 앱을 쓰는 동안에도 분석과 AI 호출을 멈추지 않으려면 배터리 최적화에서 이 앱을 제외해야 합니다. 다음 창에서 '허용'을 눌러 주세요.")
                .setPositiveButton("계속", (d, w) -> requestBatteryExemption())
                .setNegativeButton("나중에", null)
                .show();
    }

    /** 이 앱만 배터리 최적화에서 제외하는 시스템 확인 창 (한 번 '허용'이면 끝) */
    @SuppressLint("BatteryLife")
    private void requestBatteryExemption() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            openBatterySettings();
        }
    }

    private void openBatterySettings() {
        try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
        catch (Exception e) {
            try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { }
        }
    }

    // ───────── Even 앱(수신기)에 입력할 주소 ─────────
    private static final String PAGES_RX = "https://dylankang.github.io/LiveMixAndroid/?mode=hud";

    private void showReceiverUrl() {
        LocalServer.ensureStarted(this);
        final String url = PAGES_RX;
        final String local = LocalServer.receiverUrl();
        new AlertDialog.Builder(this)
                .setTitle("G2 수신기 주소 (같은 폰 자동 연결)")
                .setMessage(url + "\n\nEven 앱(Even Hub)에 이 주소를 한 번 등록하면, 같은 폰에서 이 앱이 켜져 있을 때 코드 입력 없이 자동으로 연결됩니다 (폰 안에서 직접 연결 · 인터넷 불필요). "
                        + (local != null ? "\n\n인터넷이 전혀 없을 때는 앱 내장 수신기 주소를 쓸 수 있습니다:\n" + local : ""))
                .setPositiveButton("주소 복사", (d, w) -> {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("receiver", url));
                    Toast.makeText(this, "복사했습니다", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("닫기", null)
                .show();
    }

    // ───────── 메뉴 ─────────
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_RELOAD, 0, "새로고침");
        menu.add(0, MENU_RECEIVER, 1, "G2 수신기 주소");
        menu.add(0, MENU_BATTERY, 2, "배터리 최적화 제외");
        menu.add(0, MENU_EXIT, 3, "완전히 종료");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_RELOAD: webView.reload(); return true;
            case MENU_RECEIVER: showReceiverUrl(); return true;
            case MENU_BATTERY: openBatterySettings(); return true;
            case MENU_EXIT:
                KeepAliveService.stop(this);
                finishAndRemoveTask();
                return true;
        }
        return super.onOptionsItemSelected(item);
    }

    // 뒤로 가기: 앱을 끝내지 않고 뒤로 보냄 (분석이 계속 돌도록)
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    // 일부러 webView.onPause()/pauseTimers() 를 호출하지 않는다 → 백그라운드·화면 꺼짐에도 JS·오디오 계속 동작
    @Override
    protected void onPause() { super.onPause(); }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        KeepAliveService.stop(this);
        KeepAliveService.sink = null;
        LocalServer.setInbound(null);
        if (pendingPermission != null) { pendingPermission.deny(); pendingPermission = null; }
        webView.destroy();
        super.onDestroy();
    }
}
