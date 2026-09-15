import { NextRequest } from "next/server";
import { proxyToControl } from "@/lib/control";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyToControl(`/listings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    forwardFrom: req,
  });
}
