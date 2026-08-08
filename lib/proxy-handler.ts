import { NextRequest } from "next/server";
import {
  decodeBase64Url,
  encodeBase64Url,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  getCorsHeaders,
  rewriteHtmlContent,
  rewriteCss,
  rewriteSetCookie,
  buildForwardCookieHeader,
} from "./proxy-utils";

// Known static browser & container health-check paths to ignore.
const IGNORED_STATIC_PATHS = new Set([
  "favicon.ico", "robots.txt", "sitemap.xml", "health", "healthz", "ping",
]);

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(getCorsHeaders()) },
  });
}

/** Read all Set-Cookie headers across runtimes (undici exposes getSetCookie). */
function readSetCookies(headers: Headers): string[] {
  const anyH = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyH.getSetCookie === "function") return anyH.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** Strict base64url decode — returns "" if the input isn't valid base64. */
function strictB64Decode(seg: string): string {
  try {
    let t = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = t.length % 4;
    if (pad) t += "=".repeat(4 - pad);
    return Buffer.from(t, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/** A path segment "looks encoded" if it base64-decodes to an http(s) URL. */
function looksEncoded(seg: string): boolean {
  return /^https?:\/\//i.test(strictB64Decode(seg));
}

/**
 * Given a proxied URL (e.g. a Referer like https://proxy/<b64> or
 * https://proxy/wbpge/<b64>), recover the real target URL it points at.
 */
function targetFromProxyUrl(proxyUrl: string): string | null {
  try {
    let p = new URL(proxyUrl).pathname.replace(/^\//, "");
    if (p.startsWith("wbpge/")) p = p.slice(6);
    else if (p.startsWith("ep-ws/")) p = p.slice(6);
    const seg = p.split(/[/?#]/)[0];
    if (!seg || !looksEncoded(seg)) return null;
    return decodeBase64Url(seg);
  } catch {
    return null;
  }
}

export async function handleProxyRequest(
  req: NextRequest,
  rawPath: string[],
  routePrefix: string = "/wbpge/"
): Promise<Response> {
  const prefix = routePrefix.endsWith("/") ? routePrefix : `${routePrefix}/`;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders() });
  }

  if (!rawPath || rawPath.length === 0) {
    return jsonError(400, { error: "Missing Base64 target URL path parameter." });
  }

  const b64Segment = rawPath[0];

  try {
    let targetParsedUrl: URL;
    let targetBaseUrl: string;

    if (looksEncoded(b64Segment)) {
      // Normal case: first segment is the base64-encoded target URL.
      targetBaseUrl = decodeBase64Url(b64Segment);
      targetParsedUrl = new URL(targetBaseUrl);
      const subPath = rawPath.slice(1).join("/");
      if (subPath) {
        targetParsedUrl.pathname = targetParsedUrl.pathname.replace(/\/$/, "") + "/" + subPath;
      }
    } else {
      // Escaped root-relative request (e.g. /youtubei/v1/feedback) that slipped
      // past client interception — common with Web Workers and location.href=.
      // Reconstruct the intended target from the Referer, the same way a
      // service worker would from the client's context.
      if (IGNORED_STATIC_PATHS.has(b64Segment.toLowerCase())) {
        return new Response(null, { status: 404 });
      }
      const refTarget = targetFromProxyUrl(req.headers.get("referer") || "");
      if (!refTarget) {
        return jsonError(400, {
          error: "Unproxiable path (no encoded target and no usable Referer).",
          providedSegment: b64Segment,
        });
      }
      targetParsedUrl = new URL("/" + rawPath.join("/"), refTarget);
      targetBaseUrl = targetParsedUrl.origin;
    }

    // Preserve query params.
    req.nextUrl.searchParams.forEach((val, key) => {
      targetParsedUrl.searchParams.append(key, val);
    });

    const targetUrlString = targetParsedUrl.toString();

    // Build forwarded request.
    const forwardedHeaders = sanitizeRequestHeaders(req.headers, targetUrlString);
    const forwardCookie = buildForwardCookieHeader(req.headers.get("cookie"), targetUrlString);
    if (forwardCookie) forwardedHeaders.set("cookie", forwardCookie);

    const method = req.method.toUpperCase();
    const fetchOptions: RequestInit & { duplex?: string } = {
      method,
      headers: forwardedHeaders,
      redirect: "manual", // handle redirects ourselves, staying on the proxy host
    };

    // Buffer the body (rather than stream) so the request is replayable on
    // retry and maximally compatible with serverless fetch runtimes (Wasmer).
    if (!["GET", "HEAD"].includes(method)) {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 0) fetchOptions.body = buf;
    }

    // One retry on transient upstream failures (some hosts have flaky egress).
    let targetResponse: Response;
    try {
      targetResponse = await fetch(targetUrlString, fetchOptions);
    } catch (firstErr) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        targetResponse = await fetch(targetUrlString, fetchOptions);
      } catch {
        throw firstErr;
      }
    }

    const responseHeaders = sanitizeResponseHeaders(targetResponse.headers);

    // Replay upstream Set-Cookie onto the proxy host, namespaced per origin.
    for (const c of rewriteSetCookie(readSetCookies(targetResponse.headers), targetUrlString)) {
      responseHeaders.append("set-cookie", c);
    }

    // --- Redirects: rewrite Location to a proxied URL on THIS host ----------
    // The browser stays on the proxy origin and replays cookies on the next
    // request, so auth/redirect flows keep working without navigating away.
    const status = targetResponse.status;
    if (status >= 300 && status < 400) {
      const loc = targetResponse.headers.get("location");
      if (loc) {
        const resolved = new URL(loc, targetUrlString).href;
        responseHeaders.set("location", `${prefix}${encodeBase64Url(resolved)}`);
      }
      return new Response(null, {
        status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
      });
    }

    const contentType = (targetResponse.headers.get("content-type") || "").toLowerCase();

    // HTML: rewrite links + inject the interception runtime.
    if (contentType.includes("text/html")) {
      const htmlText = await targetResponse.text();
      const rewritten = rewriteHtmlContent(htmlText, targetUrlString, prefix);
      responseHeaders.set("content-type", "text/html; charset=utf-8");
      return new Response(rewritten, {
        status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
      });
    }

    // CSS: rewrite url() and @import.
    if (contentType.includes("text/css")) {
      const cssText = await targetResponse.text();
      const rewritten = rewriteCss(cssText, targetUrlString, prefix);
      responseHeaders.set("content-type", contentType || "text/css; charset=utf-8");
      return new Response(rewritten, {
        status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
      });
    }

    // Everything else (JS, JSON, media, binary, SSE): stream straight through.
    // JavaScript is intentionally NOT statically rewritten — the injected
    // runtime intercepts its requests at execution time instead.
    return new Response(targetResponse.body, {
      status,
      statusText: targetResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return jsonError(502, {
      error: "Proxy Request Failed",
      details: errorMessage,
      segment: b64Segment,
    });
  }
}
