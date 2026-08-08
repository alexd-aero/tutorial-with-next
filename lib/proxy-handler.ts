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
  if (IGNORED_STATIC_PATHS.has(b64Segment.toLowerCase())) {
    return new Response(null, { status: 404 });
  }

  const targetBaseUrl = decodeBase64Url(b64Segment);
  if (!targetBaseUrl || !/^https?:\/\//i.test(targetBaseUrl)) {
    return jsonError(400, {
      error: "Invalid Base64 target URL.",
      providedSegment: b64Segment,
      decoded: targetBaseUrl,
    });
  }

  try {
    const subPath = rawPath.slice(1).join("/");
    const targetParsedUrl = new URL(targetBaseUrl);

    if (subPath) {
      targetParsedUrl.pathname = targetParsedUrl.pathname.replace(/\/$/, "") + "/" + subPath;
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
      targetUrl: targetBaseUrl,
    });
  }
}
