// Streamable-HTTP entrypoint: stateless, one server instance per request.
//
// Two modes:
// - Single company: credentials from the environment (token file or
//   FORTNOX_ACCESS_TOKEN), like the stdio server.
// - Per request: with FORTNOX_TOKEN_FROM_HEADER=true, each request carries the
//   Fortnox access token in `X-Fortnox-Access-Token`. That is for a host that
//   runs its own OAuth per customer and injects the token after authenticating
//   the caller.
//
// No auth here by design. Anyone who can reach this port can use whatever
// Fortnox access it holds. Put an authenticating gateway in front and never
// expose it publicly.

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFortnoxClient } from "./fortnox.js";
import { createFortnoxServer } from "./server.js";
import { staticTokens } from "./tokens.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const PER_REQUEST = process.env.FORTNOX_TOKEN_FROM_HEADER === "true";

// One client in single-company mode so the rate limiter and token refresh are shared.
const shared = PER_REQUEST ? null : createFortnoxClient();

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }
  try {
    let client = shared;
    if (!client) {
      const token = req.headers["x-fortnox-access-token"];
      if (typeof token !== "string" || !token) {
        res.statusCode = 401;
        res.end("missing X-Fortnox-Access-Token");
        return;
      }
      client = createFortnoxClient({ tokens: staticTokens(token) });
    }
    const server = createFortnoxServer({ client });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(`fortnox-mcp listening on http://0.0.0.0:${PORT} (streamable HTTP, stateless${PER_REQUEST ? ", token per request" : ""})`);
});
