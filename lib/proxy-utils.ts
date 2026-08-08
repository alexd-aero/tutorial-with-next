/**
 * Utility functions for the proxy:
 *  - Base64URL encode/decode of target URLs
 *  - Request/response header sanitization (hop-by-hop + security header stripping)
 *  - Portable, jar-less cookie rewriting (works on serverless)
 *  - HTML/CSS URL rewriting + runtime-interception injection
 */

import { getInjectionScript } from "./inject";

// ---------------------------------------------------------------------------
// Base64URL
// ---------------------------------------------------------------------------

export function decodeBase64Url(input: string): string {
  if (!input) return "";

  let cleaned = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4;
  if (pad) cleaned += "=".repeat(4 - pad);

  let decoded = "";
  try {
    decoded = Buffer.from(cleaned, "base64").toString("utf-8");
  } catch {
    try {
      decoded = atob(cleaned);
    } catch {
      decoded = input;
    }
  }

  try {
    if (decoded.includes("%")) decoded = decodeURIComponent(decoded);
  } catch {
    /* keep as-is */
  }

  if (!/^[a-z]+:\/\//i.test(decoded)) decoded = `https://${decoded}`;
  return decoded;
}

export function encodeBase64Url(input: string): string {
  if (!input) return "";
  const base64 = Buffer.from(input, "utf-8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build the proxied path for an absolute URL, e.g. "/wbpge/<b64>". */
export function proxify(absoluteUrl: string, routePrefix: string): string {
  const prefix = routePrefix.endsWith("/") ? routePrefix : `${routePrefix}/`;
  return `${prefix}${encodeBase64Url(absoluteUrl)}`;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

// Never forwarded in either direction.
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "content-encoding", "accept-encoding",
  "cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
]);

// Response headers stripped so the proxied page can be reframed/rewritten
// without the origin's security policy blocking us.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-xss-protection",
  "report-to",
  "reporting-endpoints",
  "permissions-policy",
  "feature-policy",
  "clear-site-data",
  "set-cookie",   // handled separately via rewriteSetCookie
  "location",     // handled separately (manual redirect)
]);

export function sanitizeRequestHeaders(headers: Headers, targetUrl: string): Headers {
  const clean = new Headers();
  const targetParsed = new URL(targetUrl);

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) return;
    if (lowerKey === "cookie") return;   // rebuilt from proxy jar below
    if (lowerKey === "origin") return;   // set explicitly
    if (lowerKey === "referer") return;  // set explicitly
    clean.set(key, value);
  });

  clean.set("host", targetParsed.host);
  clean.set("origin", targetParsed.origin);
  clean.set("referer", targetParsed.href);
  // Ask upstream for identity encoding so we can safely rewrite text bodies.
  clean.set("accept-encoding", "identity");

  // Mimic a real, current browser so origin servers don't serve us a bot page.
  // Only fill what the caller didn't already send (real browsers send their own).
  if (!clean.has("user-agent")) {
    clean.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  }
  if (!clean.has("accept")) {
    clean.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    );
  }
  if (!clean.has("accept-language")) clean.set("accept-language", "en-US,en;q=0.9");
  if (!clean.has("sec-ch-ua")) {
    clean.set("sec-ch-ua", '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"');
    clean.set("sec-ch-ua-mobile", "?0");
    clean.set("sec-ch-ua-platform", '"Windows"');
  }
  if (!clean.has("upgrade-insecure-requests")) clean.set("upgrade-insecure-requests", "1");

  return clean;
}

export function sanitizeResponseHeaders(headers: Headers): Headers {
  const clean = new Headers();

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) return;
    if (STRIP_RESPONSE_HEADERS.has(lowerKey)) return;
    clean.set(key, value);
  });

  clean.set("Access-Control-Allow-Origin", "*");
  clean.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS");
  clean.set("Access-Control-Allow-Headers", "*");
  clean.set("Access-Control-Expose-Headers", "*");
  clean.set("Access-Control-Allow-Credentials", "true");

  return clean;
}

export function getCorsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Allow-Credentials": "true",
  });
}

// ---------------------------------------------------------------------------
// Cookies (portable, jar-less)
//
// We can't keep a server-side cookie jar on serverless (no shared memory), so
// instead cookies are stored *on the proxy host* in the browser, namespaced by
// target origin. On the way out we reconstruct the real Cookie header from the
// namespaced cookies that belong to the target origin.
// ---------------------------------------------------------------------------

// Cookie scope host: the Domain attribute (dot stripped) if present, else the
// exact request host. This preserves real cookie semantics — a cookie set with
// Domain=.youtube.com is shared across www./consent./m.youtube.com, which is
// exactly what login/consent flows depend on.
function scopeTag(host: string): string {
  return encodeBase64Url(host.toLowerCase());
}

/**
 * Rewrite upstream Set-Cookie headers so they persist on the proxy host,
 * namespaced by cookie scope host (honoring Domain), with Path normalized.
 */
export function rewriteSetCookie(setCookies: string[], targetUrl: string): string[] {
  let reqHost = "";
  try { reqHost = new URL(targetUrl).hostname.toLowerCase(); } catch { /* noop */ }
  const out: string[] = [];

  for (const raw of setCookies) {
    if (!raw) continue;
    const parts = raw.split(";");
    const nameVal = parts.shift() || "";
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;

    const name = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1).trim();

    const attrs: string[] = [];
    let sawSameSite = false;
    let scopeHost = reqHost;

    for (const attr of parts) {
      const a = attr.trim();
      const lower = a.toLowerCase();
      if (lower.startsWith("domain=")) {
        scopeHost = a.slice(a.indexOf("=") + 1).trim().replace(/^\./, "").toLowerCase() || reqHost;
        continue; // Domain is encoded into the name, not kept on the proxy cookie
      }
      if (lower.startsWith("path=")) continue;         // normalized below
      if (lower.startsWith("samesite=")) { sawSameSite = true; attrs.push(a); continue; }
      attrs.push(a); // Expires, Max-Age, Secure, HttpOnly (dropped below), etc.
    }

    const newName = `__ep_${scopeTag(scopeHost)}__${name}`;

    // Must be JS/cross-context readable on the proxy side, so drop HttpOnly.
    const clean = attrs.filter((a) => a.toLowerCase() !== "httponly");
    clean.push("Path=/");
    if (!sawSameSite) clean.push("SameSite=Lax");

    out.push(`${newName}=${value}; ${clean.join("; ")}`);
  }

  return out;
}

/**
 * Rebuild the Cookie header to send upstream. A stored cookie scoped to host S
 * is sent to target host H when H === S or H is a subdomain of S — matching
 * standard cookie Domain-match rules.
 */
export function buildForwardCookieHeader(proxyCookieHeader: string | null, targetUrl: string): string {
  if (!proxyCookieHeader) return "";
  let host = "";
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return ""; }

  const pairs = proxyCookieHeader.split(";");
  const forwarded: string[] = [];

  for (const p of pairs) {
    const seg = p.trim();
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const name = seg.slice(0, eq);
    const m = /^__ep_([A-Za-z0-9_-]+)__(.+)$/.exec(name);
    if (!m) continue;
    const scopeHost = decodeBase64Url(m[1]).replace(/^https?:\/\//, ""); // scope stored as bare host
    if (!(host === scopeHost || host.endsWith("." + scopeHost))) continue;
    forwarded.push(`${m[2]}=${seg.slice(eq + 1)}`);
  }

  return forwarded.join("; ");
}

// ---------------------------------------------------------------------------
// HTML / CSS rewriting
// ---------------------------------------------------------------------------

function resolveToProxy(
  relativeOrAbsolute: string,
  base: URL,
  prefix: string
): string {
  if (
    !relativeOrAbsolute ||
    /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#)/i.test(relativeOrAbsolute)
  ) {
    return relativeOrAbsolute;
  }
  try {
    const resolved = new URL(relativeOrAbsolute, base.href).href;
    return `${prefix}${encodeBase64Url(resolved)}`;
  } catch {
    return relativeOrAbsolute;
  }
}

function rewriteSrcset(value: string, base: URL, prefix: string): string {
  return value
    .split(",")
    .map((part) => {
      const seg = part.trim();
      if (!seg) return seg;
      const sp = seg.split(/\s+/);
      sp[0] = resolveToProxy(sp[0], base, prefix);
      return sp.join(" ");
    })
    .join(", ");
}

/** Rewrite url(...) and @import in a CSS string. */
export function rewriteCss(css: string, targetUrl: string, routePrefix: string): string {
  const base = new URL(targetUrl);
  const prefix = routePrefix.endsWith("/") ? routePrefix : `${routePrefix}/`;

  let out = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_m, q, val) => {
    return `url(${q}${resolveToProxy(val, base, prefix)}${q})`;
  });
  // @import "x.css";  and  @import 'x.css';
  out = out.replace(/@import\s+(["'])([^"']+)\1/gi, (_m, q, val) => {
    return `@import ${q}${resolveToProxy(val, base, prefix)}${q}`;
  });
  return out;
}

export function rewriteHtmlContent(
  html: string,
  targetUrl: string,
  routePrefix: string = "/wbpge/"
): string {
  const base = new URL(targetUrl);
  const prefix = routePrefix.endsWith("/") ? routePrefix : `${routePrefix}/`;

  let out = html;

  // 0. Mask INLINE <script> bodies so URL/CSS rewriting can't corrupt JS/JSON.
  //    Keep the opening tag (so external `src` still gets rewritten); stash only
  //    the content between the tags.
  const scriptBodies: string[] = [];
  out = out.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => {
      if (!body) return `${open}${close}`;
      scriptBodies.push(body);
      return `${open}__EPJS${scriptBodies.length - 1}__${close}`;
    }
  );

  // 1. URL-bearing attributes (excludes `data`/`background` — too collision-prone).
  out = out.replace(
    /\b(href|src|action|poster|formaction)\s*=\s*(["'])(.*?)\2/gi,
    (_m, attr, quote, val) => `${attr}=${quote}${resolveToProxy(val, base, prefix)}${quote}`
  );

  // 2. srcset (comma-separated candidate list).
  out = out.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (_m, quote, val) => `srcset=${quote}${rewriteSrcset(val, base, prefix)}${quote}`
  );

  // 3. <meta http-equiv="refresh" content="5; url=...">
  out = out.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=)([^"']+)(["'])/gi,
    (_m, pre, url, post) => `${pre}${resolveToProxy(url, base, prefix)}${post}`
  );

  // 4. CSS url() / @import across inline styles and <style> blocks.
  out = out.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (_m, q, val) => `url(${q}${resolveToProxy(val, base, prefix)}${q})`);
  out = out.replace(/@import\s+(["'])([^"']+)\1/gi,
    (_m, q, val) => `@import ${q}${resolveToProxy(val, base, prefix)}${q}`);

  // 5. Strip SRI + CSP nonces (they break after we rewrite / strip CSP).
  out = out.replace(/\s+integrity\s*=\s*(["']).*?\1/gi, "");
  out = out.replace(/\s+nonce\s*=\s*(["']).*?\1/gi, "");

  // 6. Neutralize <base href> (our rewriter already resolved against target).
  out = out.replace(/<base\b[^>]*>/gi, "");

  // 6b. Restore the untouched inline <script> bodies.
  out = out.replace(/__EPJS(\d+)__/g, (_m, i) => scriptBodies[Number(i)] ?? "");

  // 7. Inject the runtime interception script at the very top of the document.
  const script = `<script>${getInjectionScript({ prefix, target: targetUrl })}</script>`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${script}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}${script}`);
  } else {
    out = script + out;
  }

  return out;
}
