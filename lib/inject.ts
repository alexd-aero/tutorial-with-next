/**
 * Client-side interception runtime.
 *
 * This is injected into every proxied HTML document. It patches the browser
 * APIs that issue network requests or navigate, so that requests made *at
 * runtime* by the page's own JavaScript (fetch / XHR / WebSocket / dynamic
 * DOM / navigation) are rewritten to go back through this proxy instead of
 * hitting the origin site directly.
 *
 * This is the difference between a "rewrite the HTML once" proxy (which breaks
 * on any modern JS-driven site) and a Scramjet/Ultraviolet-style proxy that
 * keeps working after the page boots.
 *
 * The script is deliberately dependency-free and defensive: if any single
 * patch throws (locked-down getters, exotic runtimes) it is skipped rather
 * than taking down the whole page.
 */

export interface InjectConfig {
  /** The route prefix requests are rewritten under, e.g. "/" or "/wbpge/". */
  prefix: string;
  /** The absolute URL of the document currently being proxied. */
  target: string;
}

/**
 * Returns the runtime as a self-contained IIFE string (no <script> tags).
 * Caller wraps it in a <script> and injects at the very top of <head>.
 */
export function getInjectionScript(config: InjectConfig): string {
  const prefix = config.prefix.endsWith("/") ? config.prefix : config.prefix + "/";
  const cfg = JSON.stringify({ prefix, target: config.target });

  return `(function(){
  "use strict";
  if (window.__EP_INSTALLED__) return;
  window.__EP_INSTALLED__ = true;

  var CFG = ${cfg};
  var PROXY_ORIGIN = location.origin;

  // ---- base64url helpers (UTF-8 safe) --------------------------------------
  function b64encode(str){
    try {
      var bytes = new TextEncoder().encode(str);
      var bin = "";
      for (var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
    } catch(e){
      try { return btoa(unescape(encodeURIComponent(str))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""); }
      catch(_){ return ""; }
    }
  }

  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:|#)/i;

  // Decode a base64url segment; returns "" if it isn't valid base64.
  function b64decode(seg){
    try {
      var t = seg.replace(/-/g,"+").replace(/_/g,"/");
      var pad = t.length % 4; if (pad) t += "====".slice(pad);
      return decodeURIComponent(escape(atob(t)));
    } catch(e){ return ""; }
  }

  // Is this path already a proxied path? (first segment decodes to an http URL)
  // String ops only — regex backslashes don't survive the template literal.
  function isProxiedPath(pathname){
    var p = pathname.charAt(0) === "/" ? pathname.slice(1) : pathname;
    if (p.indexOf("wbpge/") === 0) p = p.slice(6);
    else if (p.indexOf("ep-ws/") === 0) p = p.slice(6);
    var seg = p.split("/")[0].split("?")[0].split("#")[0];
    if (!seg) return false;
    var d = b64decode(seg).toLowerCase();
    return d.indexOf("http://") === 0 || d.indexOf("https://") === 0;
  }

  // Turn any URL the page uses into a proxied URL on this origin.
  //
  // The critical case: when the route prefix is "/", a naive "starts with /"
  // check treats EVERY root-relative URL (e.g. /youtubei/v1/feedback) as
  // already-proxied and lets it escape. We instead detect proxied URLs by
  // testing whether the first path segment base64-decodes to a real URL.
  function rewrite(raw){
    try {
      if (raw == null) return raw;
      var url = String(raw);
      if (!url || SKIP.test(url)) return raw;

      var pfx = CFG.prefix;

      // Absolute URL already on the proxy origin.
      if (url.indexOf(PROXY_ORIGIN) === 0) {
        var rest = url.slice(PROXY_ORIGIN.length) || "/";
        if (isProxiedPath(rest)) return url;                 // genuinely proxied
        return PROXY_ORIGIN + pfx + b64encode(new URL(rest, CFG.target).href);
      }

      // Root-relative path that is already a proxied path.
      if (url.charAt(0) === "/" && isProxiedPath(url)) return url;

      // Everything else: resolve relative to the *target* document and proxy it.
      return PROXY_ORIGIN + pfx + b64encode(new URL(url, CFG.target).href);
    } catch(e){ return raw; }
  }

  // Rewrite a ws:// or wss:// URL to a proxied ws endpoint on this origin.
  function rewriteWs(raw){
    try {
      var abs = new URL(String(raw), CFG.target).href;
      var wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
      return wsScheme + "//" + location.host + "/ep-ws/" + b64encode(abs);
    } catch(e){ return raw; }
  }
  window.__ep_rewrite = rewrite;

  // ---- fetch ---------------------------------------------------------------
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function(input, init){
        try {
          if (typeof input === "string" || input instanceof URL) {
            input = rewrite(String(input));
          } else if (input && input.url) {
            // Request object: rebuild against rewritten url, preserving options.
            var r = input;
            var opts = {
              method: r.method, headers: r.headers, body: r.body,
              mode: "cors", credentials: r.credentials, cache: r.cache,
              redirect: r.redirect, referrerPolicy: r.referrerPolicy,
              integrity: "", keepalive: r.keepalive, signal: r.signal
            };
            input = new Request(rewrite(r.url), opts);
          }
        } catch(e){}
        return _fetch.call(this, input, init);
      };
    }
  } catch(e){}

  // ---- XMLHttpRequest ------------------------------------------------------
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try { arguments[1] = rewrite(url); } catch(e){}
      return _open.apply(this, arguments);
    };
  } catch(e){}

  // ---- WebSocket -----------------------------------------------------------
  try {
    var _WS = window.WebSocket;
    if (_WS) {
      var WSProxy = function(url, protocols){
        var target = rewriteWs(url);
        return protocols === undefined ? new _WS(target) : new _WS(target, protocols);
      };
      WSProxy.prototype = _WS.prototype;
      WSProxy.CONNECTING = _WS.CONNECTING; WSProxy.OPEN = _WS.OPEN;
      WSProxy.CLOSING = _WS.CLOSING; WSProxy.CLOSED = _WS.CLOSED;
      window.WebSocket = WSProxy;
    }
  } catch(e){}

  // ---- EventSource (SSE) ---------------------------------------------------
  try {
    var _ES = window.EventSource;
    if (_ES) {
      var ESProxy = function(url, cfg){ return new _ES(rewrite(url), cfg); };
      ESProxy.prototype = _ES.prototype;
      ESProxy.CONNECTING = _ES.CONNECTING; ESProxy.OPEN = _ES.OPEN; ESProxy.CLOSED = _ES.CLOSED;
      window.EventSource = ESProxy;
    }
  } catch(e){}

  // ---- Worker / SharedWorker (best-effort: proxy the script URL) -----------
  try {
    var _Worker = window.Worker;
    if (_Worker) {
      var Wk = function(url, opts){ return new _Worker(rewrite(url), opts); };
      Wk.prototype = _Worker.prototype;
      window.Worker = Wk;
    }
  } catch(e){}
  try {
    var _SW = window.SharedWorker;
    if (_SW) {
      var SWk = function(url, opts){ return new _SW(rewrite(url), opts); };
      SWk.prototype = _SW.prototype;
      window.SharedWorker = SWk;
    }
  } catch(e){}

  // ---- sendBeacon ----------------------------------------------------------
  try {
    if (navigator.sendBeacon) {
      var _beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data){ return _beacon(rewrite(url), data); };
    }
  } catch(e){}

  // ---- window.open ---------------------------------------------------------
  try {
    var _wopen = window.open;
    window.open = function(url){
      var args = Array.prototype.slice.call(arguments);
      if (url) args[0] = rewrite(url);
      return _wopen.apply(window, args);
    };
  } catch(e){}

  // ---- history.pushState / replaceState ------------------------------------
  // Keep the address bar on the proxy origin so reloads/back work.
  try {
    ["pushState","replaceState"].forEach(function(fn){
      var orig = history[fn];
      history[fn] = function(state, title, url){
        try { if (url != null) url = rewrite(url); } catch(e){}
        return orig.call(this, state, title, url);
      };
    });
  } catch(e){}

  // ---- location.assign / replace -------------------------------------------
  try {
    var _assign = location.assign.bind(location);
    location.assign = function(url){ return _assign(rewrite(url)); };
    var _replace = location.replace.bind(location);
    location.replace = function(url){ return _replace(rewrite(url)); };
  } catch(e){}

  // ---- Element attribute setters -------------------------------------------
  var URL_ATTRS = { src:1, href:1, action:1, poster:1, "xlink:href":1, "data-src":1, formaction:1 };
  try {
    var _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value){
      try {
        var lname = String(name).toLowerCase();
        if (URL_ATTRS[lname]) value = rewrite(value);
        else if (lname === "srcset") value = rewriteSrcset(value);
      } catch(e){}
      return _setAttr.call(this, name, value);
    };
  } catch(e){}

  function rewriteSrcset(v){
    try {
      return String(v).split(",").map(function(part){
        var seg = part.trim(); if(!seg) return seg;
        var sp = seg.split(/\\s+/);
        sp[0] = rewrite(sp[0]);
        return sp.join(" ");
      }).join(", ");
    } catch(e){ return v; }
  }

  // ---- Property setters on common elements ---------------------------------
  function patchProp(proto, prop, isSrcset){
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set || !d.configurable) return;
      Object.defineProperty(proto, prop, {
        configurable:true, enumerable:d.enumerable,
        get: d.get,
        set: function(v){ try { v = isSrcset ? rewriteSrcset(v) : rewrite(v); } catch(e){} return d.set.call(this, v); }
      });
    } catch(e){}
  }
  try { patchProp(HTMLImageElement.prototype, "src"); patchProp(HTMLImageElement.prototype, "srcset", true); } catch(e){}
  try { patchProp(HTMLScriptElement.prototype, "src"); } catch(e){}
  try { patchProp(HTMLMediaElement.prototype, "src"); } catch(e){}
  try { patchProp(HTMLIFrameElement.prototype, "src"); } catch(e){}
  try { patchProp(HTMLSourceElement.prototype, "src"); patchProp(HTMLSourceElement.prototype, "srcset", true); } catch(e){}
  try { patchProp(HTMLLinkElement.prototype, "href"); } catch(e){}
  try { patchProp(HTMLAnchorElement.prototype, "href"); } catch(e){}
  try { patchProp(HTMLFormElement.prototype, "action"); } catch(e){}
  try { patchProp(HTMLTrackElement.prototype, "src"); } catch(e){}
  try { patchProp(HTMLEmbedElement.prototype, "src"); } catch(e){}
  try { patchProp(HTMLObjectElement.prototype, "data"); } catch(e){}

  // ---- Catch-all: rewrite nodes inserted after boot ------------------------
  function fixNode(node){
    if (!node || node.nodeType !== 1) return;
    try {
      for (var a in URL_ATTRS) {
        if (node.hasAttribute && node.hasAttribute(a)) {
          var val = node.getAttribute(a);
          var nv = rewrite(val);
          if (nv !== val) _setAttr.call(node, a, nv);
        }
      }
      if (node.hasAttribute && node.hasAttribute("srcset")) {
        _setAttr.call(node, "srcset", rewriteSrcset(node.getAttribute("srcset")));
      }
      if (node.querySelectorAll) {
        var kids = node.querySelectorAll("[src],[href],[action],[poster],[srcset],[data-src],[formaction]");
        for (var i=0;i<kids.length;i++) fixNode(kids[i]);
      }
    } catch(e){}
  }
  try {
    var mo = new MutationObserver(function(muts){
      for (var i=0;i<muts.length;i++){
        var m = muts[i];
        if (m.type === "childList") {
          for (var j=0;j<m.addedNodes.length;j++) fixNode(m.addedNodes[j]);
        }
      }
    });
    var startObserve = function(){ try { mo.observe(document.documentElement, {childList:true, subtree:true}); } catch(e){} };
    if (document.documentElement) startObserve();
    else document.addEventListener("readystatechange", startObserve, {once:true});
  } catch(e){}

  // ---- Anchor/form fallbacks (capture phase) -------------------------------
  try {
    document.addEventListener("click", function(e){
      try {
        var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        var href = a.getAttribute("href");
        if (!href || SKIP.test(href)) return;
        var nv = rewrite(href);
        if (nv !== href && a.href.indexOf(PROXY_ORIGIN) !== 0) a.setAttribute("href", nv);
      } catch(_){}
    }, true);
  } catch(e){}
})();`;
}
