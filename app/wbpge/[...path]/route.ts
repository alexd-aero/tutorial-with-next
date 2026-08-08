import { NextRequest } from "next/server";
import { handleProxyRequest } from "@/lib/proxy-handler";

export const runtime = "nodejs"; // Supports full streaming and duplex fetch

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  return handleProxyRequest(req, params.path, "/wbpge/");
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE, proxy as PATCH, proxy as HEAD, proxy as OPTIONS };
