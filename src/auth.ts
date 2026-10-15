// `fortnox-mcp login`: the OAuth authorization-code flow, once, on this machine.
//
// Starts a short-lived local server on the redirect URI's port, prints the
// Fortnox consent URL, waits for the redirect, checks `state`, exchanges the
// code and writes the token file. After that the MCP server refreshes on its own.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { AUTH_URL, loadConfig, type FortnoxConfig } from "./config.js";
import { tokenRequest, writeTokenFile, FortnoxAuthError, type FetchFn } from "./tokens.js";

export function authorizeUrl(cfg: FortnoxConfig, state: string): string {
  if (!cfg.clientId) throw new FortnoxAuthError("FORTNOX_CLIENT_ID must be set.");
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(" "),
    state,
    // Without offline there is no refresh token and the connection dies in an hour.
    access_type: "offline",
    response_type: "code",
  });
  // Omitted when empty: Fortnox rejects an empty account_type.
  if (cfg.accountType) p.set("account_type", cfg.accountType);
  return `${AUTH_URL}?${p}`;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`;

export async function login(cfg: FortnoxConfig = loadConfig(), fetchFn: FetchFn = fetch): Promise<void> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new FortnoxAuthError(
      "Set FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET from your app in Fortnox's Developer Portal " +
      "(https://apps.fortnox.se/integration-developer), with the redirect URI " + cfg.redirectUri + ".",
    );
  }
  const redirect = new URL(cfg.redirectUri);
  if (!["localhost", "127.0.0.1"].includes(redirect.hostname)) {
    throw new FortnoxAuthError(`FORTNOX_REDIRECT_URI must point at localhost for \`login\`, got ${cfg.redirectUri}.`);
  }
  const state = randomBytes(16).toString("hex");

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", cfg.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string, body: string, err?: Error) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, body));
        server.close();
        err ? reject(err) : resolve();
      };
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? "";
        return finish(400, "Fortnox declined", `${error}: ${desc}`, new FortnoxAuthError(`Authorization declined: ${error} ${desc}`));
      }
      if (url.searchParams.get("state") !== state) {
        return finish(400, "State mismatch", "Start the login again.", new FortnoxAuthError("State mismatch; start the login again."));
      }
      const code = url.searchParams.get("code");
      if (!code) return finish(400, "No code", "Fortnox returned no authorization code.", new FortnoxAuthError("No authorization code returned."));
      try {
        const tokens = await tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri }, fetchFn);
        await writeTokenFile(cfg.tokenFile, tokens);
        console.error(`Connected${tokens.tenant_id ? ` to Fortnox tenant ${tokens.tenant_id}` : ""}. Tokens saved to ${cfg.tokenFile}.`);
        finish(200, "Connected to Fortnox", "You can close this tab and go back to your AI client.");
      } catch (e) {
        finish(500, "Token exchange failed", String((e as Error).message), e as Error);
      }
    });
    server.on("error", reject);
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.error("Open this URL in a browser, sign in to Fortnox and approve the access:\n");
      console.error(authorizeUrl(cfg, state) + "\n");
      console.error(`Waiting for the redirect on ${cfg.redirectUri} …`);
    });
  });
}
