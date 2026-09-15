import { NextRequest } from "next/server";
import { proxyToControl } from "@/lib/control";

export async function GET(req: NextRequest) {
  return proxyToControl("/listings", { forwardFrom: req });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyToControl("/listings", { method: "POST", body, forwardFrom: req });
}
