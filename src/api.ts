// Plain-fetch transport in the style of QuitLARP's solveApi.ts: JSON bodies,
// credentials included by default, errors carry the HTTP status and `{detail|error}` text.
export interface ApiOptions {
  /** e.g. "/api/v1/assessments/42/sessions/current". No trailing slash. */
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Defaults to "include" (cookie sessions), like QuitLARP. */
  credentials?: RequestCredentials;
  /** Inject your own fetch, e.g. createMockServer().fetch. */
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
  keepalive?: boolean;
}

async function errorMessage(res: Response) {
  let detail: unknown;
  try {
    const data = (await res.json()) as { detail?: unknown; error?: unknown };
    detail = data?.detail ?? data?.error;
  } catch { detail = undefined; }
  return typeof detail === 'string' && detail ? detail : `Request failed (HTTP ${res.status})`;
}

export function createApi(o: ApiOptions) {
  return {
    async request<T = unknown>(path: string, r: RequestOptions): Promise<T> {
      const qs = r.query ? '?' + new URLSearchParams(r.query).toString() : '';
      const extra = typeof o.headers === 'function' ? await o.headers() : o.headers;
      const res = await (o.fetch ?? fetch)(`${o.baseUrl}${path}${qs}`, {
        method: r.method,
        credentials: o.credentials ?? 'include',
        keepalive: r.keepalive,
        headers: { ...(r.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
      });
      if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}
