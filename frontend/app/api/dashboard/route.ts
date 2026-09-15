import { NextRequest } from "next/server";
import { proxyToControl } from "@/lib/control";

export async function GET(req: NextRequest) {
  return proxyToControl("/dashboard", { forwardFrom: req });
}
