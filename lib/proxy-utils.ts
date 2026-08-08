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

function originTag(targetUrl: string): string {
  try {
    const o = new URL(targetUrl).origin;
    return encodeBase64Url(o);
  } catch {
    return "_";
  }
}

/**
 * Rewrite upstream Set-Cookie headers so they persist on the proxy host,
 * namespaced per target origin, with Domain stripped and Path normalized.
 */
export function rewriteSetCookie(setCookies: string[], targetUrl: string): string[] {
  const tag = originTag(targetUrl);
  const out: string[] = [];

  for (const raw of setCookies) {
    if (!raw) continue;
    const parts = raw.split(";");
    const nameVal = parts.shift() || "";
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;

    const name = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1).trim();
    const newName = `__ep_${tag}__${name}`;

    const attrs: string[] = [];
    let sawSameSite = false;
    let sawSecure = false;

    for (const attr of parts) {
      const a = attr.trim();
      const lower = a.toLowerCase();
      if (lower.startsWith("domain=")) continue;       // pin to proxy host
      if (lower.startsWith("path=")) continue;         // normalized below
      if (lower === "samesite=none") { sawSameSite = true; attrs.push("SameSite=None"); continue; }
      if (lower.startsWith("samesite=")) { sawSameSite = true; attrs.push(a); continue; }
      if (lower === "secure") { sawSecure = true; attrs.push("Secure"); continue; }
      attrs.push(a); // Expires, Max-Age, HttpOnly (dropped below), etc.
    }

    // We need JS + cross-context reads, so never HttpOnly on the proxy side.
    const noHttpOnly = attrs.filter((a) => a.toLowerCase() !== "httponly");
    noHttpOnly.push("Path=/");
    if (!sawSameSite) noHttpOnly.push("SameSite=Lax");
    void sawSecure;

    out.push(`${newName}=${value}; ${noHttpOnly.join("; ")}`);
  }

  return out;
}

/**
 * Rebuild the Cookie header to send upstream, from the proxy-host cookies that
 * belong to the target origin.
 */
export function buildForwardCookieHeader(proxyCookieHeader: string | null, targetUrl: string): string {
  if (!proxyCookieHeader) return "";
  const tag = originTag(targetUrl);
  const wantPrefix = `__ep_${tag}__`;

  const pairs = proxyCookieHeader.split(";");
  const forwarded: string[] = [];

  for (const p of pairs) {
    const seg = p.trim();
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const name = seg.slice(0, eq);
    if (!name.startsWith(wantPrefix)) continue;
    const realName = name.slice(wantPrefix.length);
    const value = seg.slice(eq + 1);
    forwarded.push(`${realName}=${value}`);
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

  // 1. URL-bearing attributes.
  out = out.replace(
    /\b(href|src|action|poster|formaction|data|background)\s*=\s*(["'])(.*?)\2/gi,
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
