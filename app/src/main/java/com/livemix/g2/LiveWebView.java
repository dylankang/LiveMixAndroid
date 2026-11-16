package com.livemix.g2;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * 화면이 꺼지거나 다른 앱이 앞에 와도 '보이는 페이지'로 남는 WebView.
 *
 * 원인: 화면이 꺼지면 안드로이드가 액티비티 창을 숨기고(onWindowVisibilityChanged(GONE/INVISIBLE)) WebView 는 이를
 * Chromium 에 그대로 전달한다 → 페이지가 hidden 이 되고, 렌더러 우선순위가 내려가며 30초~1분 뒤 오디오 처리·스크립트가
 * 멈춘다(분석·하트비트 중단 → 수신기에 'PC 신호 대기중').
 * 해결: 분석 중(keepVisible)에는 창이 숨겨져도 Chromium 에는 VISIBLE 로 알린다. (분석을 멈추면 원래대로 숨김을 전달)
 */
public class LiveWebView extends WebView {
    private boolean keepVisible = false;
    private int realWindowVisibility = View.VISIBLE;

    public LiveWebView(Context context) { super(context); }

    /** 분석 중이면 true: 창이 숨겨져도 페이지를 계속 '보이는' 상태로 유지 */
    public void setKeepVisible(boolean keep) {
        if (keepVisible == keep) return;
        keepVisible = keep;
        // 끌 때는 실제 창 상태를 다시 알려 준다 (배터리 절약)
        super.onWindowVisibilityChanged(keep ? View.VISIBLE : realWindowVisibility);
    }

    public boolean isKeepVisible() { return keepVisible; }

    /** 백그라운드 멈춤이 감지됐을 때: 다시 '보이는' 상태를 강제로 알려 렌더러를 깨움 */
    public void nudgeVisible() {
        super.onWindowVisibilityChanged(View.VISIBLE);
        onResume();
        resumeTimers();
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        realWindowVisibility = visibility;
        super.onWindowVisibilityChanged(keepVisible ? View.VISIBLE : visibility);
    }

    @Override
    protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, keepVisible ? View.VISIBLE : visibility);
    }
}
