package com.livemix.g2;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * 폰 안(127.0.0.1)에서만 열리는 초소형 웹 서버 (다른 기기에서는 접속 불가 · 루프백 전용).
 *  1) 같은 폰의 Even 앱(수신기)이 http://127.0.0.1:8765/?mode=hud 로 이 앱에 포함된 HUD 수신기 화면을 불러올 수 있다.
 *  2) 📱 같은 폰 자동 연결 버스 (코드·인터넷 불필요):
 *     - GET  /lm/poll?after=N  → {"last":번호,"msgs":[...]}  분석기가 보낸 메시지(상태·레벨·하트비트). after=0 이면 마지막 상태(retain)만
 *     - POST /lm/post?topic=status|hud (본문 = JSON 메시지) → 수신기의 hello·ack·cmd(쿨다운 초기화 등)를 분석기(WebView)로 전달
 *     GitHub Pages(https)에서 열린 수신기도 http://127.0.0.1 로 접근할 수 있게 CORS / Private Network Access 헤더를 붙인다.
 */
final class LocalServer {
    static final int FIRST_PORT = 8765;
    private static final int MAX_MSGS = 400;
    private static ServerSocket server;
    private static int port = -1;

    /** 수신기 → 분석기 메시지 전달 대상 (MainActivity 가 등록) */
    interface Inbound { void onMessage(String json); }
    private static volatile Inbound inbound;

    // 분석기 → 수신기 메시지 (번호 순서)
    private static final Object LOCK = new Object();
    private static final ArrayDeque<long[]> ids = new ArrayDeque<>();
    private static final ArrayDeque<String> msgs = new ArrayDeque<>();
    private static final Map<String, String> retained = new HashMap<>();
    private static long lastId = 0;

    private LocalServer() { }

    static void setInbound(Inbound cb) { inbound = cb; }

    /** 분석기(WebView)가 보낸 메시지를 수신기들이 가져가도록 보관 */
    static void publish(String topic, String json, boolean retain) {
        if (json == null) return;
        synchronized (LOCK) {
            lastId++;
            ids.addLast(new long[]{lastId});
            msgs.addLast(json);
            while (msgs.size() > MAX_MSGS) { msgs.removeFirst(); ids.removeFirst(); }
            if (retain) retained.put(topic == null ? "hud" : topic, json);
            LOCK.notifyAll();
        }
    }

    private static String pollJson(long after) {
        StringBuilder sb = new StringBuilder(256);
        synchronized (LOCK) {
            sb.append("{\"last\":").append(lastId).append(",\"msgs\":[");
            boolean first = true;
            long oldest = ids.isEmpty() ? lastId + 1 : ids.peekFirst()[0];
            if (after <= 0 || after < oldest - 1 || after > lastId) {
                for (String r : retained.values()) { if (!first) sb.append(','); sb.append(r); first = false; }
            } else {
                Iterator<long[]> it = ids.iterator();
                Iterator<String> im = msgs.iterator();
                while (it.hasNext()) {
                    long id = it.next()[0];
                    String m = im.next();
                    if (id <= after) continue;
                    if (!first) sb.append(',');
                    sb.append(m);
                    first = false;
                }
            }
            sb.append("]}");
        }
        return sb.toString();
    }

    static synchronized void ensureStarted(final Context ctx) {
        if (server != null && !server.isClosed()) return;
        final Context app = ctx.getApplicationContext();
        for (int p = FIRST_PORT; p < FIRST_PORT + 3; p++) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 16);
                server = s;
                port = p;
                break;
            } catch (IOException ignored) { }
        }
        if (server == null) return;
        final ServerSocket s = server;
        Thread t = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    final Socket c = s.accept();
                    Thread h = new Thread(() -> handle(app, c), "livemix-http");
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) { break; }
            }
        }, "livemix-accept");
        t.setDaemon(true);
        t.start();
    }

    static synchronized int port() { return port; }

    static synchronized String receiverUrl() {
        return port < 0 ? null : "http://127.0.0.1:" + port + "/?mode=hud";
    }

    private static void handle(Context ctx, Socket c) {
        try {
            c.setSoTimeout(5000);
            InputStream in = c.getInputStream();
            // 헤더 읽기 (\r\n\r\n 까지)
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int n = 0, b;
            int[] last = new int[4];
            while ((b = in.read()) != -1 && head.size() < 16384) {
                head.write(b);
                last[n++ & 3] = b;
                if (n >= 4 && last[(n - 4) & 3] == '\r' && last[(n - 3) & 3] == '\n' && last[(n - 2) & 3] == '\r' && last[(n - 1) & 3] == '\n') break;
            }
            String headStr = new String(head.toByteArray(), StandardCharsets.ISO_8859_1);
            String[] lines = headStr.split("\r\n");
            String[] parts = lines.length > 0 ? lines[0].split(" ") : new String[0];
            OutputStream out = c.getOutputStream();
            if (parts.length < 2) { reply(out, 400, "text/plain", bytes("Bad Request"), false); return; }
            String method = parts[0];
            String full = parts[1];
            String path = full, query = "";
            int q = full.indexOf('?');
            if (q >= 0) { path = full.substring(0, q); query = full.substring(q + 1); }
            int contentLength = 0;
            for (String l : lines) {
                int i = l.indexOf(':');
                if (i > 0 && l.substring(0, i).trim().equalsIgnoreCase("content-length")) {
                    try { contentLength = Integer.parseInt(l.substring(i + 1).trim()); } catch (NumberFormatException ignored) { }
                }
            }

            if (method.equals("OPTIONS")) { reply(out, 204, "text/plain", new byte[0], false); return; }   // CORS / PNA 사전 확인

            if (path.equals("/lm/poll")) {
                long after = 0;
                String a = param(query, "after");
                if (a != null) { try { after = Long.parseLong(a); } catch (NumberFormatException ignored) { } }
                reply(out, 200, "application/json", pollJson(after).getBytes(StandardCharsets.UTF_8), method.equals("HEAD"));
                return;
            }
            if (path.equals("/lm/post") && method.equals("POST")) {
                if (contentLength < 0 || contentLength > 65536) { reply(out, 413, "text/plain", bytes("Too Large"), false); return; }
                byte[] body = new byte[contentLength];
                int off = 0;
                while (off < contentLength) {
                    int r = in.read(body, off, contentLength - off);
                    if (r < 0) break;
                    off += r;
                }
                String json = new String(body, 0, off, StandardCharsets.UTF_8).trim();
                Inbound cb = inbound;
                if (cb != null && json.startsWith("{")) cb.onMessage(json);
                reply(out, 200, "application/json", bytes("{\"ok\":true}"), false);
                return;
            }

            if (!(method.equals("GET") || method.equals("HEAD"))) {
                reply(out, 405, "text/plain", bytes("Method Not Allowed"), false);
                return;
            }
            String rel = WebAssets.resolve(path);
            byte[] body = null;
            if (rel != null) {
                try (InputStream a = WebAssets.open(ctx, rel)) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int r;
                    while ((r = a.read(buf)) > 0) bo.write(buf, 0, r);
                    body = bo.toByteArray();
                } catch (IOException ignored) { }
            }
            if (body == null) reply(out, 404, "text/plain", bytes("Not Found"), method.equals("HEAD"));
            else reply(out, 200, WebAssets.mime(rel), body, method.equals("HEAD"));
        } catch (IOException ignored) {
        } finally {
            try { c.close(); } catch (IOException ignored) { }
        }
    }

    private static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    private static String param(String query, String key) {
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(key)) return kv.substring(i + 1);
        }
        return null;
    }

    private static void reply(OutputStream out, int code, String mime, byte[] body, boolean headOnly) throws IOException {
        String ct = WebAssets.isText(mime) ? mime + "; charset=utf-8" : mime;
        String reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 404 ? "Not Found" : "Error";
        String h = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: " + ct + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Access-Control-Max-Age: 600\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly && body.length > 0) out.write(body);
        out.flush();
    }
}
