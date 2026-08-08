/**
 * Scramjet proxy server.
 *
 * Uses MercuryWorkshop's Scramjet (via @mercuryworkshop/proxy-bootstrap) which
 * serves the Scramjet client/service-worker assets and runs the wisp transport.
 *
 *   /go/<base64url>   -> friendly entry: registers the SW and hands the URL to
 *                        Scramjet, which loads the page and handles redirects,
 *                        cookies, and the site's own service workers.
 *
 * REQUIRES a socket-capable Node host (Render/Railway/Fly/VPS/local). It will
 * NOT function on Wasmer serverless — wisp needs WebSocket upgrades + raw
 * outbound sockets, which that runtime does not provide (connect => ENOSYS).
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Downloads + prepares Scramjet assets and wires the wisp transport.
// Absolute asset dir so it works regardless of the process cwd.
const { routeRequest, routeUpgrade } = await bootstrap({
  downloadedFilesDir: path.join(__dirname, ".scramjet-assets") + path.sep,
});

const app = express();
const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || "0.0.0.0";

/**
 * The `/go/<b64>` API. `<b64>` is a base64url-encoded absolute URL.
 * We serve a tiny bootstrap page that registers the Scramjet service worker,
 * then navigates to the Scramjet-encoded URL so the SW takes over.
 */
app.get("/go/:b64", (req, res) => {
  const b64 = req.params.b64;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Loading…</title>
<style>html,body{margin:0;height:100%;background:#0b0e14;color:#e6edf3;font:15px system-ui,sans-serif;overflow:hidden}
#frame{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff}
#ov{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:#0b0e14;transition:opacity .3s;z-index:2}
.sp{width:34px;height:34px;border:3px solid #2b3550;border-top-color:#6ea8fe;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}} .err{color:#ff7b72;max-width:560px;text-align:center;padding:0 16px}</style>
<script src="/bootstrap-init.js"></script></head>
<body>
<iframe id="frame" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media" allowfullscreen></iframe>
<div id="ov"><div class="sp"></div><div id="m">Starting proxy…</div></div>
<script>
(async () => {
  const m = document.getElementById("m");
  const ov = document.getElementById("ov");
  const iframe = document.getElementById("frame");
  try {
    const controller = await initBootstrap();
    await navigator.serviceWorker.ready;
    let s = ${JSON.stringify(b64)}.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const url = decodeURIComponent(escape(atob(s)));
    m.textContent = "Loading " + url;
    const frame = controller.createFrame(iframe);
    frame.go(url);
    iframe.addEventListener("load", () => { ov.style.opacity = "0"; setTimeout(() => ov.remove(), 350); }, { once: true });
    setTimeout(() => { ov.style.opacity = "0"; setTimeout(() => ov.remove(), 350); }, 6000);
  } catch (e) {
    ov.innerHTML =
      '<div class="err"><b>Proxy failed to start.</b><br>' + (e && e.message ? e.message : e) +
      '<br><br>This needs a socket-capable Node host (wisp transport). It cannot run on Wasmer serverless.</div>';
  }
})();
</script></body></html>`);
});

// Scramjet asset + bootstrap + service-worker routes (/sw.js, /bootstrap-init.js, /scram/*, /controller/*, /clients/*).
app.use((req, res, next) => {
  if (routeRequest(req, res)) return;
  next();
});

// Static frontend (landing page).
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
server.on("upgrade", routeUpgrade); // wisp WebSocket transport
server.listen(PORT, HOST, () => {
  console.log(`Scramjet proxy on http://${HOST}:${PORT}  (entry: /go/<base64url>)`);
});
