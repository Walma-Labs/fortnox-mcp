// Access tokens: obtain, persist, refresh.
//
// The one thing that matters here: Fortnox ROTATES the refresh token on every
// refresh and the old one dies at once. A refresh that succeeds but is not
// saved leaves the connection broken until someone logs in again. So the new
// pair is written to disk before the access token is used, and concurrent
// tool calls share one in-flight refresh instead of racing two (the loser
// would present a refresh token the winner just killed).
//
// A refresh token lives 45 days. Any use within that window renews it, so a
// server that is used at least monthly never needs a new login.

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { TOKEN_URL, type FortnoxConfig } from "./config.js";

export type FetchFn = typeof fetch;

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when the access token stops working (with a minute of margin). */
  expires_at: number;
  scope?: string;
  /** Fortnox tenant id, read from the access token's claims. */
  tenant_id?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export class FortnoxAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FortnoxAuthError";
  }
}

/**
 * The tenant id claim from an access token. Not verified: it only labels which
 * company the token belongs to; no access decision is made on it.
 */
export function tenantFromJwt(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { tenantId?: string | number };
    return claims.tenantId != null ? String(claims.tenantId) : undefined;
  } catch {
    return undefined;
  }
}

export async function tokenRequest(
  cfg: FortnoxConfig,
  body: Record<string, string>,
  fetchFn: FetchFn = fetch,
): Promise<StoredTokens> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new FortnoxAuthError("FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must be set.");
  }
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FortnoxAuthError(`Fortnox token endpoint answered ${res.status}: ${text.slice(0, 300)}`);
  }
  const t = JSON.parse(text) as TokenResponse;
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
    scope: t.scope,
    tenant_id: tenantFromJwt(t.access_token),
  };
}

export interface TokenProvider {
  /** A currently valid access token. */
  get(): Promise<string>;
  /** Force a refresh on the next get(), after the API answered 401. */
  invalidate(): void;
}

/** A fixed token supplied by the host. */
export function staticTokens(token: string): TokenProvider {
  return { get: async () => token, invalidate: () => {} };
}

export async function readTokenFile(path: string): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StoredTokens;
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/** Atomic write, readable by the owner only: the file holds a live credential. */
export async function writeTokenFile(path: string, tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** Tokens from the file written by `fortnox-mcp login`, refreshed as needed. */
export function fileTokens(cfg: FortnoxConfig, fetchFn: FetchFn = fetch): TokenProvider {
  let cached: StoredTokens | null = null;
  let stale = false;
  // Everything from "read the file" to "refreshed and saved" is one shared
  // promise. Checking for an in-flight refresh only after an await would let
  // two concurrent calls both refresh, and the second would present a refresh
  // token the first had just killed.
  let inflight: Promise<string> | null = null;

  async function resolve(): Promise<string> {
    if (!cached) cached = await readTokenFile(cfg.tokenFile);
    if (!cached) {
      throw new FortnoxAuthError(
        `Not connected to Fortnox: no token file at ${cfg.tokenFile}. Run \`fortnox-mcp login\` first.`,
      );
    }
    if (!stale && cached.expires_at > Date.now()) return cached.access_token;
    const current = cached;
    try {
      const next = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: current.refresh_token }, fetchFn);
      await writeTokenFile(cfg.tokenFile, next);
      cached = next;
      stale = false;
      return next.access_token;
    } catch (e) {
      // Another process (a second client running this server) may have
      // rotated the token. Re-read the file once before giving up.
      const onDisk = await readTokenFile(cfg.tokenFile);
      if (onDisk && onDisk.refresh_token !== current.refresh_token && onDisk.expires_at > Date.now()) {
        cached = onDisk;
        stale = false;
        return onDisk.access_token;
      }
      throw e;
    }
  }

  return {
    get() {
      if (!inflight) inflight = resolve().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() {
      stale = true;
    },
  };
}

export function tokensFromConfig(cfg: FortnoxConfig, fetchFn: FetchFn = fetch): TokenProvider {
  return cfg.accessToken ? staticTokens(cfg.accessToken) : fileTokens(cfg, fetchFn);
}
