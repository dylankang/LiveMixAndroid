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

/**
 * 폰 안(127.0.0.1)에서만 열리는 초소형 웹 서버 — Even 앱(수신기)이 http://127.0.0.1:8765/?mode=hud 로 접속해
 * 이 앱에 포함된 HUD 수신기 화면을 불러오게 한다. 외부 인터넷·Netlify 불필요. 다른 기기에서는 접속 불가(루프백 전용).
 */
final class LocalServer {
    private static final int FIRST_PORT = 8765;
    private static ServerSocket server;
    private static int port = -1;

    private LocalServer() { }

    static synchronized void ensureStarted(final Context ctx) {
        if (server != null && !server.isClosed()) return;
        final Context app = ctx.getApplicationContext();
        for (int p = FIRST_PORT; p < FIRST_PORT + 10; p++) {
            try {
                server = new ServerSocket(p, 8, InetAddress.getByName("127.0.0.1"));
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
                    new Thread(() -> handle(app, c), "livemix-http").start();
                } catch (IOException e) { break; }
            }
        }, "livemix-accept");
        t.setDaemon(true);
        t.start();
    }

    static synchronized String receiverUrl() {
        return port < 0 ? null : "http://127.0.0.1:" + port + "/?mode=hud";
    }

    private static void handle(Context ctx, Socket c) {
        try {
            c.setSoTimeout(5000);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int prev = 0, n = 0, b;
            int[] last = new int[4];
            while ((b = in.read()) != -1 && head.size() < 8192) {
                head.write(b);
                last[n++ & 3] = b;
                if (n >= 4 && last[(n - 4) & 3] == '\r' && last[(n - 3) & 3] == '\n' && last[(n - 2) & 3] == '\r' && last[(n - 1) & 3] == '\n') break;
            }
            String line = new String(head.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n", 2)[0];
            String[] parts = line.split(" ");
            OutputStream out = c.getOutputStream();
            if (parts.length < 2 || !(parts[0].equals("GET") || parts[0].equals("HEAD"))) {
                reply(out, 405, "text/plain", "Method Not Allowed".getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            String path = parts[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
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
            if (body == null) reply(out, 404, "text/plain", "Not Found".getBytes(StandardCharsets.UTF_8), parts[0].equals("HEAD"));
            else reply(out, 200, WebAssets.mime(rel), body, parts[0].equals("HEAD"));
        } catch (IOException ignored) {
        } finally {
            try { c.close(); } catch (IOException ignored) { }
        }
    }

    private static void reply(OutputStream out, int code, String mime, byte[] body, boolean headOnly) throws IOException {
        String ct = WebAssets.isText(mime) ? mime + "; charset=utf-8" : mime;
        String h = "HTTP/1.1 " + code + (code == 200 ? " OK" : code == 404 ? " Not Found" : " Error") + "\r\n"
                + "Content-Type: " + ct + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) out.write(body);
        out.flush();
    }
}
