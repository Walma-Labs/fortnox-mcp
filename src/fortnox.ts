// A thin Fortnox API client: auth header, rate limit, retries, error mapping,
// pagination. Nothing Fortnox-domain-specific lives here.

import { API_BASE, loadConfig, type FortnoxConfig } from "./config.js";
import { tokensFromConfig, type FetchFn, type TokenProvider } from "./tokens.js";

export type { FetchFn };

/**
 * Fortnox allows 25 requests per 5 seconds per access token. Spacing calls
 * 220 ms apart stays under that with room for a second client on the same
 * token, and does it up front rather than by bouncing off 429s.
 */
const MIN_SPACING_MS = 220;
const MAX_RETRIES = 4;

export class FortnoxApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code: number | undefined,
    readonly fortnoxMessage: string,
  ) {
    super(`Fortnox ${status} on ${path}: ${fortnoxMessage}${code ? ` (code ${code})` : ""}`);
    this.name = "FortnoxApiError";
  }

  toJSON() {
    return { status: this.status, path: this.path, code: this.code, message: this.fortnoxMessage, hint: hintFor(this) };
  }
}

/** Plain-language next steps for the errors people actually hit. */
function hintFor(e: FortnoxApiError): string | undefined {
  if (e.status === 401) return "The token was rejected. Run `fortnox-mcp login` again.";
  if (e.status === 403 || e.code === 2000663) {
    return "Missing scope or licence for this resource. Add the scope to FORTNOX_SCOPES, enable it for the app in the Developer Portal, and log in again with a user who holds that licence.";
  }
  if (e.status === 404) return "Not found. Check the number or id; Fortnox numbers are per company.";
  if (e.status === 429) return "Rate limited by Fortnox. Wait a few seconds and narrow the request.";
  return undefined;
}

/** Strip anything that looks like a credential before it reaches the model. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret)"?\s*[:=]\s*"?[^"&\s,}]+/gi, "$1=[redacted]");
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface FortnoxClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  getBytes(path: string, query?: Query): Promise<Uint8Array>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Follows MetaInformation pages until `max` items or the last page. */
  list<T = unknown>(path: string, key: string, query?: Query, max?: number): Promise<{ items: T[]; total: number; truncated: boolean }>;
}

export interface ClientOptions {
  fetch?: FetchFn;
  config?: () => FortnoxConfig;
  tokens?: TokenProvider;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function createFortnoxClient(opts: ClientOptions = {}): FortnoxClient {
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let tokens = opts.tokens;
  const provider = () => (tokens ??= tokensFromConfig((opts.config ?? loadConfig)(), fetchFn));

  let nextSlot = 0;
  async function throttle() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + MIN_SPACING_MS;
    if (at > now) await sleep(at - now);
  }

  async function request(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
    const url = buildUrl(path, query);
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      await throttle();
      const token = await provider().get();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.ok) return res;

      if (res.status === 401 && !reauthed) {
        reauthed = true;
        provider().invalidate();
        continue;
      }
      // 429 and 5xx are transient. Writes are only retried on 429, which
      // Fortnox returns before doing anything; a 5xx on a POST may have
      // created the document already.
      const transient = res.status === 429 || (res.status >= 500 && method === "GET");
      if (transient && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let code: number | undefined;
      let message = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { ErrorInformation?: { code?: number; message?: string; Code?: number; Message?: string }; message?: string };
        const info = j.ErrorInformation;
        code = info?.code ?? info?.Code;
        message = info?.message ?? info?.Message ?? j.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new FortnoxApiError(res.status, new URL(url).pathname, code, redact(message));
    }
  }

  async function json<T>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async get<T>(path: string, query?: Query) {
      return json<T>(await request("GET", path, query));
    },
    async getBytes(path: string, query?: Query) {
      // Accept stays application/json even for files: Fortnox answers 400 to
      // other Accept values on several file endpoints.
      return new Uint8Array(await (await request("GET", path, query)).arrayBuffer());
    },
    async post<T>(path: string, body: unknown) {
      return json<T>(await request("POST", path, undefined, body));
    },
    async put<T>(path: string, body?: unknown) {
      return json<T>(await request("PUT", path, undefined, body));
    },
    async list<T>(path: string, key: string, query: Query = {}, max = 500) {
      const items: T[] = [];
      let page = 1;
      let total = 0;
      // One page size for every page: Fortnox pages by offset = (page-1) * limit,
      // so changing the limit between pages skips or repeats rows.
      const limit = Math.min(500, Math.max(1, max));
      for (;;) {
        const res = await json<Record<string, unknown>>(await request("GET", path, { ...query, limit, page }));
        const meta = res.MetaInformation as { "@TotalPages"?: number; "@TotalResources"?: number } | undefined;
        const batch = (res[key] as T[] | undefined) ?? [];
        items.push(...batch);
        total = meta?.["@TotalResources"] ?? items.length;
        const pages = meta?.["@TotalPages"] ?? 1;
        if (page >= pages || items.length >= max || batch.length === 0) break;
        page++;
      }
      return { items: items.slice(0, max), total, truncated: total > Math.min(items.length, max) };
    },
  };
}
