import { NextRequest } from "next/server";
import { proxyToControl } from "@/lib/control";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ ip: string }> }
) {
  const { ip } = await params;
  return proxyToControl(`/sessions/${encodeURIComponent(ip)}`, {
    method: "DELETE",
    forwardFrom: req,
  });
}
