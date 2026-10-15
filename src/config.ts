// Configuration from the environment. Two ways to authenticate:
//
// 1. OAuth app (the normal case). FORTNOX_CLIENT_ID + FORTNOX_CLIENT_SECRET from
//    your app in Fortnox's Developer Portal, and a token file written once by
//    `fortnox-mcp login`. The server refreshes the access token itself.
// 2. FORTNOX_ACCESS_TOKEN: a ready access token. For hosts that run their own
//    OAuth and hand the server a per-tenant token per request. No refresh.

import { homedir } from "node:os";
import { join } from "node:path";

export const AUTH_URL = "https://apps.fortnox.se/oauth-v1/auth";
export const TOKEN_URL = "https://apps.fortnox.se/oauth-v1/token";
export const API_BASE = "https://api.fortnox.se";

/**
 * Scopes requested by `fortnox-mcp login` unless FORTNOX_SCOPES says otherwise.
 *
 * Every scope is a licence the approving user must hold in Fortnox, and asking
 * for one they lack fails the whole authorization. So the default is what the
 * read tools need for an ordinary invoicing + bookkeeping company, nothing more.
 */
export const DEFAULT_SCOPES = [
  "companyinformation",
  "bookkeeping",
  "invoice",
  "customer",
  "supplierinvoice",
  "supplier",
  "article",
  "payment",
  "settings",
] as const;

export interface FortnoxConfig {
  clientId?: string;
  clientSecret?: string;
  /** Static access token; when set, no refresh is attempted. */
  accessToken?: string;
  tokenFile: string;
  redirectUri: string;
  scopes: string[];
  /** "service" for a service account (needs a system administrator to approve). */
  accountType?: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): FortnoxConfig {
  const scopes = (env.FORTNOX_SCOPES ?? DEFAULT_SCOPES.join(" "))
    .split(/[\s,]+/)
    .filter(Boolean);
  return {
    clientId: env.FORTNOX_CLIENT_ID || undefined,
    clientSecret: env.FORTNOX_CLIENT_SECRET || undefined,
    accessToken: env.FORTNOX_ACCESS_TOKEN || undefined,
    tokenFile: env.FORTNOX_TOKEN_FILE || join(homedir(), ".config", "fortnox-mcp", "tokens.json"),
    redirectUri: env.FORTNOX_REDIRECT_URI || "http://localhost:8765/callback",
    scopes,
    accountType: env.FORTNOX_ACCOUNT_TYPE || undefined,
  };
}

export function writesEnabled(env: Env = process.env): boolean {
  return env.FORTNOX_ENABLE_WRITES === "true";
}
