/**
 * Optional custom server that adds REAL WebSocket proxying on top of Next.js.
 *
 * Use this on any Node-capable host (Render / Railway / Fly / VPS / Wasmer that
 * runs `node server.js`). On serverless (Vercel functions) you cannot run this;
 * there the app still works for everything except live WebSockets, which fail
 * gracefully via app/__ep_ws__/[...path]/route.ts.
 *
 *   Start:  node server.js         (production, after `next build`)
 *   Dev:    NODE_ENV=development node server.js
 */

const http = require("http");
const next = require("next");
const { WebSocketServer, WebSocket } = require("ws");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const WS_PREFIX = "/ep-ws/";

// --- helpers (mirror lib/proxy-utils.ts, kept dependency-free) --------------

function decodeBase64Url(input) {
  if (!input) return "";
  let cleaned = String(input).trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4;
  if (pad) cleaned += "=".repeat(4 - pad);
  let decoded = Buffer.from(cleaned, "base64").toString("utf-8");
  try { if (decoded.includes("%")) decoded = decodeURIComponent(decoded); } catch (_) {}
  if (!/^[a-z]+:\/\//i.test(decoded)) decoded = "https://" + decoded;
  return decoded;
}

function encodeBase64Url(input) {
  return Buffer.from(String(input), "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Reconstruct the upstream Cookie header from proxy-host cookies for this origin.
function forwardCookie(cookieHeader, targetUrl) {
  if (!cookieHeader) return "";
  let tag;
  try { tag = encodeBase64Url(new URL(targetUrl).origin); } catch (_) { return ""; }
  const want = "__ep_" + tag + "__";
  const out = [];
  for (const p of cookieHeader.split(";")) {
    const seg = p.trim();
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const name = seg.slice(0, eq);
    if (!name.startsWith(want)) continue;
    out.push(name.slice(want.length) + "=" + seg.slice(eq + 1));
  }
  return out.join("; ");
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));

  // Next's own upgrade handler (HMR websocket in dev, etc.).
  const nextUpgrade =
    typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch (_) {}

    if (!pathname.startsWith(WS_PREFIX)) {
      // Hand non-proxy upgrades (e.g. Next HMR) back to Next.
      if (nextUpgrade) return nextUpgrade(req, socket, head);
      socket.destroy();
      return;
    }

    const b64 = pathname.slice(WS_PREFIX.length).split("/")[0];
    let targetUrl;
    try {
      targetUrl = decodeBase64Url(b64);
      const u = new URL(targetUrl);
      // ws/wss target scheme derived from http/https.
      if (u.protocol === "https:") u.protocol = "wss:";
      else if (u.protocol === "http:") u.protocol = "ws:";
      targetUrl = u.toString();
    } catch (_) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const headers = {};
      const cookie = forwardCookie(req.headers.cookie, targetUrl);
      if (cookie) headers["cookie"] = cookie;
      if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
      try { headers["origin"] = new URL(targetUrl).origin.replace(/^ws/, "http"); } catch (_) {}

      const subprotocols = (req.headers["sec-websocket-protocol"] || "")
        .split(",").map((s) => s.trim()).filter(Boolean);

      const upstream = new WebSocket(targetUrl, subprotocols, { headers });

      const closeBoth = (code, reason) => {
        try { client.close(code, reason); } catch (_) {}
        try { upstream.close(code, reason); } catch (_) {}
      };

      // Buffer client->upstream messages sent before the upstream is open,
      // so nothing sent immediately on connect is dropped.
      const pending = [];
      client.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push([data, isBinary]);
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on("open", () => {
        for (const [data, isBinary] of pending) {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        }
        pending.length = 0;
      });

      client.on("close", (c, r) => closeBoth(c, r));
      upstream.on("close", (c, r) => closeBoth(c, r));
      client.on("error", () => closeBoth());
      upstream.on("error", (e) => { console.error("[ws] upstream error:", e && e.message); closeBoth(1011, "upstream error"); });
      upstream.on("unexpected-response", (_r, res) => { console.error("[ws] upstream refused:", res.statusCode); closeBoth(1011, "upstream refused"); });
    });
  });

  server.listen(port, hostname, () => {
    console.log(`> Proxy ready on http://${hostname}:${port} (WebSocket proxy enabled)`);
  });
});
