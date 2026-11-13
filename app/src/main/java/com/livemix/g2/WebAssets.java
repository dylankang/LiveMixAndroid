package com.livemix.g2;

import android.content.Context;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/** 앱에 포함된 웹앱 파일(assets/www)을 읽는 도우미 — 앱 화면과 수신기용 로컬 서버가 함께 사용 */
final class WebAssets {
    /** 앱 내부 가상 주소 (https 라 마이크(getUserMedia)·보안 컨텍스트 기능이 그대로 동작) */
    static final String HOST = "appassets.androidplatform.net";
    static final String BASE = "https://" + HOST + "/";

    private WebAssets() { }

    static String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".wav")) return "audio/wav";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
    }

    /** URL 경로(쿼리 제외) → assets/www 안의 상대 경로. 잘못된 경로면 null */
    static String resolve(String urlPath) {
        String p = urlPath == null ? "" : urlPath;
        if (p.startsWith("/")) p = p.substring(1);
        if (p.isEmpty()) p = "index.html";
        if (p.contains("..") || p.contains("\\")) return null;
        return p;
    }

    static InputStream open(Context c, String rel) throws IOException {
        return c.getAssets().open("www/" + rel);
    }
}
