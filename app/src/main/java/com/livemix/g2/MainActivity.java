package com.livemix.g2;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * Live Mix Assistant 안드로이드 앱.
 * - Netlify 에 올린 같은 웹앱(분석기)을 WebView 로 띄운다 → 웹 코드를 고치면 앱은 다시 빌드할 필요 없음
 * - 웹이 [시작]을 누르면 LiveMixNative.setRunning(true) 를 호출 → 포그라운드 서비스로 화면이 꺼져도/다른 앱을 열어도 분석 유지
 * - 크롬과 달리 앱은 WebView 를 일시정지시키지 않는다 (onPause 에서 webView.onPause()/pauseTimers() 를 호출하지 않음)
 */
public class MainActivity extends Activity {
    private static final String PREFS = "livemix";
    private static final String KEY_URL = "url";
    private static final String KEY_BATTERY_ASKED = "batteryAsked";
    private static final int REQ_AUDIO = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int REQ_FILE = 3;
    private static final int MENU_URL = 1, MENU_RELOAD = 2, MENU_BATTERY = 3, MENU_EXIT = 4;

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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost();
                Uri base = Uri.parse(getUrl());
                // 같은 사이트는 앱 안에서, 다른 사이트(문서 링크 등)는 외부 브라우저로
                if (host != null && host.equals(base.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
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

        String url = getUrl();
        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else if (url.startsWith("https://") && url.length() > "https://".length()) webView.loadUrl(url);
        else askUrl(true);
    }

    // ───────── 웹 ↔ 앱 연결 ─────────
    private class NativeBridge {
        @JavascriptInterface
        public boolean isNative() { return true; }

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
                .setMessage("안드로이드가 화면 꺼짐 중에 앱을 멈추지 않도록 배터리 최적화에서 이 앱을 제외할까요?")
                .setPositiveButton("제외하기", (d, w) -> openBatterySettings())
                .setNegativeButton("나중에", null)
                .show();
    }

    @SuppressLint("BatteryLife")
    private void openBatterySettings() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) { }
        }
    }

    // ───────── 웹앱 주소 (Netlify) ─────────
    private String getUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, getString(R.string.default_url));
    }

    private void askUrl(boolean firstRun) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(getUrl());
        input.setSelection(input.getText().length());
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("분석기 웹앱 주소")
                .setMessage("Netlify에 올린 주소를 입력하세요 (예: https://내사이트.netlify.app/)\n수신기 주소(?mode=hud)가 아니라 기본 주소입니다.")
                .setView(input)
                .setPositiveButton("열기", (d, w) -> {
                    String u = input.getText().toString().trim();
                    if (!u.startsWith("https://")) u = "https://" + u.replaceFirst("^https?://", "");
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, u).apply();
                    webView.loadUrl(u);
                });
        if (!firstRun) b.setNegativeButton("취소", null);
        else b.setCancelable(false);
        b.show();
    }

    // ───────── 메뉴 ─────────
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_RELOAD, 0, "새로고침");
        menu.add(0, MENU_URL, 1, "주소 변경");
        menu.add(0, MENU_BATTERY, 2, "배터리 최적화 제외");
        menu.add(0, MENU_EXIT, 3, "완전히 종료");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_RELOAD: webView.reload(); return true;
            case MENU_URL: askUrl(false); return true;
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
        if (pendingPermission != null) { pendingPermission.deny(); pendingPermission = null; }
        webView.destroy();
        super.onDestroy();
    }
}
