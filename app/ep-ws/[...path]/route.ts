import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * WebSocket endpoint placeholder for serverless / non-WS hosts.
 *
 * Real WebSocket proxying requires access to the raw socket for the HTTP
 * `Upgrade` handshake, which Next.js App Router route handlers do not provide.
 * When the app runs under the bundled custom server (`node server.js`, used on
 * Node/Wasmer hosts), upgrade requests to this path are intercepted BEFORE they
 * reach this handler and proxied for real — so this code only runs on platforms
 * that cannot support WebSockets (e.g. Vercel serverless functions).
 *
 * Returning 501 makes the client-side WebSocket fail fast with a clean
 * error/close event instead of hanging, so pages degrade gracefully.
 */
function unsupported(req: NextRequest): Response {
  const isUpgrade = (req.headers.get("upgrade") || "").toLowerCase() === "websocket";
  return new Response(
    JSON.stringify({
      error: "WebSocket proxying is not available on this host.",
      hint: "Run with the bundled custom server (`node server.js`) on a Node/Wasmer host for real WebSocket support.",
      wasUpgrade: isUpgrade,
    }),
    { status: 501, headers: { "Content-Type": "application/json" } }
  );
}

export { unsupported as GET, unsupported as POST };
