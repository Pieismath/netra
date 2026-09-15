import { NextResponse, type NextRequest } from "next/server";

export const CONTROL_API =
  process.env.CONTROL_API ?? process.env.NEXT_PUBLIC_CONTROL_API ?? "http://localhost:3001";

interface ProxyOptions extends RequestInit {
  forwardFrom?: NextRequest;
}

export async function proxyToControl(
  path: string,
  init?: ProxyOptions
): Promise<NextResponse> {
  const { forwardFrom, ...rest } = init ?? {};
  const forwardedAuth = forwardFrom?.headers.get("authorization");
  try {
    const res = await fetch(`${CONTROL_API}${path}`, {
      cache: "no-store",
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(forwardedAuth ? { Authorization: forwardedAuth } : {}),
        ...(rest.headers ?? {}),
      },
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "control API unreachable";
    return NextResponse.json(
      { error: "control_api_unreachable", message },
      { status: 502 }
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
