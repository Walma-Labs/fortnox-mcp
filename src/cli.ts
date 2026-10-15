#!/usr/bin/env node
// `fortnox-mcp`          stdio MCP server (Claude Code, Claude Desktop, Cursor, …)
// `fortnox-mcp login`    connect a Fortnox company once (OAuth in the browser)
// `fortnox-mcp status`   show which company the saved tokens belong to

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { login } from "./auth.js";
import { createFortnoxServer } from "./server.js";
import { readTokenFile } from "./tokens.js";

const cmd = process.argv[2];

if (cmd === "login") {
  try {
    await login();
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "status") {
  const cfg = loadConfig();
  const t = await readTokenFile(cfg.tokenFile);
  if (!t) {
    console.log(`Not connected. Run \`fortnox-mcp login\`. (Looked in ${cfg.tokenFile})`);
  } else {
    console.log(JSON.stringify({ token_file: cfg.tokenFile, tenant_id: t.tenant_id, scope: t.scope, access_token_valid_until: new Date(t.expires_at).toISOString() }, null, 2));
  }
} else if (cmd && cmd !== "stdio") {
  console.error("Usage: fortnox-mcp [login | status | stdio]");
  process.exit(2);
} else {
  await createFortnoxServer().connect(new StdioServerTransport());
}
