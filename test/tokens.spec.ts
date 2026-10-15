// Token handling: the rotating refresh token is saved before use, concurrent
// calls share one refresh, and a 401 forces exactly one refresh.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createFortnoxClient } from "../src/fortnox.js";
import { fileTokens, writeTokenFile, tenantFromJwt } from "../src/tokens.js";

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

async function setup(expired: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "fortnox-mcp-"));
  const cfg = loadConfig({ FORTNOX_CLIENT_ID: "id", FORTNOX_CLIENT_SECRET: "secret", FORTNOX_TOKEN_FILE: join(dir, "tokens.json") });
  await writeTokenFile(cfg.tokenFile, { access_token: "old-access", refresh_token: "r1", expires_at: expired ? Date.now() - 1000 : Date.now() + 3_600_000 });
  return cfg;
}

describe("file tokens", () => {
  it("refreshes once for concurrent callers and persists the rotated refresh token", async () => {
    const cfg = await setup(true);
    let refreshes = 0;
    const fetchFn = (async (_url: any, init: any) => {
      refreshes++;
      expect(init.headers.Authorization).toBe("Basic " + Buffer.from("id:secret").toString("base64"));
      expect(String(init.body)).toContain("grant_type=refresh_token");
      expect(String(init.body)).toContain("refresh_token=r1");
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ access_token: jwt({ tenantId: 42 }), refresh_token: "r2", expires_in: 3600 }));
    }) as typeof fetch;
    const t = fileTokens(cfg, fetchFn);
    const [a, b] = await Promise.all([t.get(), t.get()]);
    expect(a).toBe(b);
    expect(refreshes).toBe(1);
    const saved = JSON.parse(await readFile(cfg.tokenFile, "utf8"));
    expect(saved.refresh_token).toBe("r2");
    expect(saved.tenant_id).toBe("42");
    expect((await stat(cfg.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("uses a valid token without refreshing", async () => {
    const cfg = await setup(false);
    const t = fileTokens(cfg, (async () => { throw new Error("should not refresh"); }) as typeof fetch);
    expect(await t.get()).toBe("old-access");
  });

  it("refreshes after a 401 and retries the call once", async () => {
    const cfg = await setup(false);
    const seen: string[] = [];
    const fetchFn = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("oauth-v1/token")) return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "r2", expires_in: 3600 }));
      seen.push(init.headers.Authorization);
      return init.headers.Authorization === "Bearer old-access"
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify({ Invoice: { DocumentNumber: "1" } }));
    }) as typeof fetch;
    const client = createFortnoxClient({ fetch: fetchFn, tokens: fileTokens(cfg, fetchFn), sleep: async () => {} });
    expect(await client.get("/3/invoices/1")).toEqual({ Invoice: { DocumentNumber: "1" } });
    expect(seen).toEqual(["Bearer old-access", "Bearer new-access"]);
  });

  it("explains how to connect when there is no token file", async () => {
    const cfg = loadConfig({ FORTNOX_TOKEN_FILE: "/nonexistent/fortnox/tokens.json" });
    await expect(fileTokens(cfg).get()).rejects.toThrow(/fortnox-mcp login/);
  });

  it("reads the tenant id claim", () => {
    expect(tenantFromJwt(jwt({ tenantId: "123" }))).toBe("123");
    expect(tenantFromJwt("garbage")).toBeUndefined();
  });
});
