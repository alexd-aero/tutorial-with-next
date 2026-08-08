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

/** The /go entry page: boots Scramjet, loads the target in a frame, hacker loader. */
function entryHtml(b64) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Establishing tunnel…</title>
<style>
  html,body{margin:0;height:100%;background:#05070a;overflow:hidden;font-family:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace}
  #frame{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff}
  #ov{position:fixed;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(1000px 500px at 50% 10%,#0a1622 0%,#05070a 70%);transition:opacity .5s ease}
  #ov.hide{opacity:0}
  .term{width:min(660px,92vw);color:#33ff9f;text-shadow:0 0 8px rgba(51,255,159,.45);
        border:1px solid rgba(51,255,159,.25);border-radius:10px;background:rgba(3,10,8,.72);
        box-shadow:0 0 40px rgba(51,255,159,.08),inset 0 0 60px rgba(51,255,159,.04);padding:0 0 16px;overflow:hidden}
  .bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(51,255,159,.18);
       background:rgba(51,255,159,.06);font-size:12px;letter-spacing:.12em;color:#7dffc4}
  .dot{width:9px;height:9px;border-radius:50%;background:#33ff9f;box-shadow:0 0 10px #33ff9f;animation:pulse 1s infinite}
  @keyframes pulse{50%{opacity:.25}}
  .title{flex:1}
  .host{color:#eafff5;text-shadow:0 0 10px rgba(120,255,200,.6)}
  .body{padding:14px 16px 4px;font-size:13.5px;line-height:1.7}
  #log{max-height:230px;overflow:hidden}
  .ln{white-space:pre-wrap;opacity:0;transform:translateY(4px);animation:in .18s forwards}
  @keyframes in{to{opacity:1;transform:none}}
  .ok{color:#33ff9f}.warn{color:#ffd166}.go{color:#7dfcff;text-shadow:0 0 12px rgba(125,252,255,.7)}
  .big{font-size:16px;letter-spacing:.14em;margin-top:6px}
  .cursor{display:inline-block;width:9px;height:16px;background:#33ff9f;box-shadow:0 0 10px #33ff9f;
          vertical-align:-2px;margin-left:4px;animation:blink .9s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  .track{height:6px;margin:14px 16px 4px;border-radius:6px;background:rgba(51,255,159,.12);overflow:hidden}
  #bar{height:100%;width:0;border-radius:6px;background:linear-gradient(90deg,#0aff9d,#7dfcff);
       box-shadow:0 0 14px rgba(51,255,159,.7);transition:width .4s ease}
  .meta{display:flex;justify-content:space-between;padding:6px 16px 0;font-size:11px;color:#3f7d68;letter-spacing:.1em}
  /* scanlines + flicker */
  #ov::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:10;
    background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.22) 3px);
    animation:flick 4s infinite}
  @keyframes flick{0%,100%{opacity:.55}50%{opacity:.35}}
  .err{color:#ff6b6b;max-width:560px;text-align:center;padding:20px;text-shadow:0 0 8px rgba(255,107,107,.4)}
</style>
<script src="/bootstrap-init.js"></script></head>
<body>
<iframe id="frame" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>
<div id="ov">
  <div class="term">
    <div class="bar"><span class="dot"></span><span class="title">SCRAMJET // SECURE TUNNEL</span><span id="host" class="host">target</span></div>
    <div class="body"><div id="log"></div><div id="cur"><span class="cursor"></span></div></div>
    <div class="track"><div id="bar"></div></div>
    <div class="meta"><span id="pct">0%</span><span>wisp · epoxy · sw-injected</span></div>
  </div>
</div>
<script>
(async () => {
  var ov = document.getElementById("ov");
  var log = document.getElementById("log");
  var bar = document.getElementById("bar");
  var pctEl = document.getElementById("pct");
  var hostEl = document.getElementById("host");
  var curWrap = document.getElementById("cur");
  var iframe = document.getElementById("frame");

  var s = ${JSON.stringify(b64)}.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var url;
  try { url = decodeURIComponent(escape(atob(s))); } catch (e) { url = atob(s); }
  try { hostEl.textContent = new URL(url).host; } catch (e) { hostEl.textContent = url; }

  var steps = [
    "initializing scramjet core",
    "handshaking wisp tunnel",
    "negotiating epoxy transport",
    "injecting service worker",
    "spoofing tls fingerprint",
    "rewriting js runtime + DOM tree",
    "bypassing CORS / CSP / x-frame guards",
    "unwrapping media source extensions",
    "cloaking origin headers"
  ];
  var i = 0, finished = false;
  function line(html, cls) {
    var d = document.createElement("div");
    d.className = "ln " + (cls || "");
    d.innerHTML = html;
    log.appendChild(d);
  }
  function setPct(p) { bar.style.width = p + "%"; pctEl.textContent = p + "%"; }
  function tick() {
    if (i < steps.length) {
      line('<span class="ok">[ OK ]</span> ' + steps[i]);
      i++;
      setPct(Math.min(90, Math.round((i / steps.length) * 90)));
      setTimeout(tick, 220 + Math.random() * 300);
    }
  }
  tick();

  function finish() {
    if (finished) return; finished = true;
    setPct(100);
    if (curWrap) curWrap.remove();
    line('<span class="go">[ &gt;&gt; ] ACCESS GRANTED &mdash; welcome in.</span>', "big");
    setTimeout(function () { ov.classList.add("hide"); setTimeout(function () { ov.remove(); }, 550); }, 550);
  }

  // Boot Scramjet with sourcemaps OFF (the big memory hog that crashes heavy
  // players like YouTube) — baked in at controller construction, not after.
  // Falls back to the stock bootstrap path if anything here changes upstream.
  async function bootWithFlags() {
    var FLAGS = {
      syncxhr: false, disableComputedWrap: false, rewriterLogs: false,
      captureErrors: true, cleanErrors: true, scramitize: false,
      sourcemaps: false, destructureRewrites: true, allowInvalidJs: true,
      debugTrampolines: false, allowFailedIntercepts: true,
      encapsulateWorkers: true, debugSourceURL: false
    };
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement("script");
        s.src = src; s.onload = function () { res(); };
        s.onerror = function () { rej(new Error("load " + src)); };
        document.head.appendChild(s);
      });
    }
    async function registerSw(path) {
      var reg = await navigator.serviceWorker.register(path, { type: "classic", updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      if (reg.active) return reg.active;
      var inst = reg.installing || reg.waiting;
      if (inst) {
        await new Promise(function (res) {
          inst.addEventListener("statechange", function h() {
            if (inst.state === "activated") { inst.removeEventListener("statechange", h); res(); }
          });
        });
      }
      return navigator.serviceWorker.controller || reg.active;
    }
    try {
      var sw = await registerSw("/sw.js");
      await loadScript("/scram/scramjet.js");
      await loadScript("/controller/controller.api.js");
      await loadScript("/scram/scramjet-utils.js");
      var wisp = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/wisp/";
      await loadScript("/clients/libcurl-client.js");
      var transport = new window.LibcurlTransport.LibcurlClient({ wisp: wisp });
      var C = window.$scramjetController;
      C.config.injectPath = "/controller/controller.inject.js";
      C.config.wasmPath = "/scram/scramjet.wasm";
      C.config.scramjetPath = "/scram/scramjet.js";
      var ctl = new C.Controller({ serviceworker: sw, transport: transport, scramjetConfig: { flags: FLAGS } });
      if (ctl.wait) { try { await ctl.wait(); } catch (_) {} }
      return ctl;
    } catch (err) {
      // Fallback: stock bootstrap (still flips flags best-effort).
      var ctl2 = await initBootstrap();
      try {
        var f = ctl2 && ctl2.scramjetConfig && ctl2.scramjetConfig.flags;
        if (f) { f.sourcemaps = false; f.allowFailedIntercepts = true; f.captureErrors = true; }
      } catch (_) {}
      return ctl2;
    }
  }

  try {
    var controller = await bootWithFlags();
    await navigator.serviceWorker.ready;
    var frame = controller.createFrame(iframe);
    frame.go(url);
    iframe.addEventListener("load", function () { setTimeout(finish, 400); }, { once: true });
    setTimeout(finish, 12000); // safety fallback
  } catch (e) {
    ov.innerHTML = '<div class="err"><b>Tunnel failed.</b><br>' + (e && e.message ? e.message : e) +
      '<br><br>Needs a socket-capable Node host (wisp transport) &mdash; not Wasmer serverless.</div>';
  }
})();
</script></body></html>`;
}

/**
 * The `/go/<b64>` API. `<b64>` is a base64url-encoded absolute URL.
 * Serves a page that boots Scramjet, loads the target in a Scramjet frame, and
 * shows a "bypassing" hacker-style loader until the frame is ready.
 */
app.get("/go/:b64", (req, res) => {
  const b64 = req.params.b64;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.end(entryHtml(b64));
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
