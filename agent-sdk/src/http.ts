import axios, { AxiosInstance } from "axios";

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers?: Record<string, string>;
}

export interface HttpClient {
  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>>;
  post<T = unknown>(
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>>;
}

export class AxiosHttpClient implements HttpClient {
  private instance: AxiosInstance;

  constructor(timeoutMs = 15000) {
    this.instance = axios.create({
      timeout: timeoutMs,
      validateStatus: () => true,
    });
  }

  async get<T>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    const res = await this.instance.get<T>(url, { headers });
    return { status: res.status, data: res.data, headers: res.headers as Record<string, string> };
  }

  async post<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    const res = await this.instance.post<T>(url, body, {
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    });
    return { status: res.status, data: res.data, headers: res.headers as Record<string, string> };
  }

  async delete<T>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    const res = await this.instance.delete<T>(url, { headers });
    return { status: res.status, data: res.data, headers: res.headers as Record<string, string> };
  }
}

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
