import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const customMessage = req.nextUrl.searchParams.get("msg") || "Hello from Next.js Streaming API Proxy!";

  const stream = new ReadableStream({
    async start(controller) {
      const chunks = [
        `[Stream Started] Target message: "${customMessage}"\n`,
        `Chunk 1/5: Initiating proxy connection...\n`,
        `Chunk 2/5: Streaming data payload via ReadableStream...\n`,
        `Chunk 3/5: Real-time response header & body chunking verified!\n`,
        `Chunk 4/5: Supporting GET, POST, WS, SSE and web pages...\n`,
        `Chunk 5/5: [Stream Complete]\n`,
      ];

      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
