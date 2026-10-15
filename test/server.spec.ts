// Server tests: the real MCP wire (in-memory transport) and the real Fortnox
// client against a mocked fetch. Proves tool registration, the read-only
// default, the exact requests sent, pagination, the endpoint allowlist, the
// preview-before-write rule, error mapping and the SIE-based reports, all
// without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFortnoxServer, matchGetPath } from "../src/server.js";
import { createFortnoxClient, type FetchFn } from "../src/fortnox.js";
import { staticTokens } from "../src/tokens.js";

interface Call { url: URL; method: string; headers: Record<string, string>; body: any }
type Reply = { status?: number; json?: unknown; bytes?: Uint8Array };

function mockFetch(reply: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fn: FetchFn = (async (input: any, init: any = {}) => {
    const call: Call = { url: new URL(String(input)), method: init.method ?? "GET", headers: { ...(init.headers ?? {}) }, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = reply(call);
    const body = r.bytes ? r.bytes : r.json !== undefined ? JSON.stringify(r.json) : null;
    return new Response(body as any, { status: r.status ?? 200 });
  }) as FetchFn;
  return { fn, calls };
}

async function connect(fetchFn: FetchFn, enableWrites = false) {
  const client = createFortnoxClient({ fetch: fetchFn, tokens: staticTokens("tok"), sleep: async () => {} });
  const server = createFortnoxServer({ client, enableWrites });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

const json = (r: any) => JSON.parse(r.content[0].text);
const call = (mcp: Client, name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args });

const WRITE_TOOLS = ["create_customer", "create_invoice_draft", "create_offer", "create_order"];

describe("tool registration", () => {
  it("is read-only by default", async () => {
    const mcp = await connect(mockFetch(() => ({ json: {} })).fn);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(names).toContain("income_statement");
    expect(names).toContain("fortnox_get");
    for (const t of (await mcp.listTools()).tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("adds draft-only write tools when enabled", async () => {
    const mcp = await connect(mockFetch(() => ({ json: {} })).fn, true);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).toContain(w);
    const writes = (await mcp.listTools()).tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    expect(writes.sort()).toEqual([...WRITE_TOOLS].sort());
  });
});

describe("reads", () => {
  it("lists invoices with filters, bearer auth and compact rows", async () => {
    const m = mockFetch(() => ({
      json: {
        MetaInformation: { "@TotalPages": 1, "@TotalResources": 1 },
        Invoices: [{ DocumentNumber: "101", CustomerName: "Acme", Total: 1250, Balance: 1250, DueDate: "2026-09-30", "@url": "x", Sent: true, VATIncluded: false }],
      },
    }));
    const mcp = await connect(m.fn);
    const r = json(await call(mcp, "list_invoices", { filter: "unpaidoverdue", from_date: "2026-01-01" }));
    const c = m.calls[0]!;
    expect(c.url.pathname).toBe("/3/invoices");
    expect(c.url.searchParams.get("filter")).toBe("unpaidoverdue");
    expect(c.url.searchParams.get("fromdate")).toBe("2026-01-01");
    expect(c.headers.Authorization).toBe("Bearer tok");
    expect(r.invoices[0]).toEqual({ DocumentNumber: "101", CustomerName: "Acme", Total: 1250, Balance: 1250, DueDate: "2026-09-30", Sent: true });
  });

  it("follows pagination with a fixed page size", async () => {
    const m = mockFetch((c) => {
      const page = Number(c.url.searchParams.get("page"));
      return { json: { MetaInformation: { "@TotalPages": 3, "@TotalResources": 5 }, Customers: page < 3 ? [{ CustomerNumber: `${page}a` }, { CustomerNumber: `${page}b` }] : [{ CustomerNumber: "3a" }] } };
    });
    const mcp = await connect(m.fn);
    const r = json(await call(mcp, "list_customers", { max: 2000 }));
    expect(r.customers).toHaveLength(5);
    expect(new Set(m.calls.map((c) => c.url.searchParams.get("limit")))).toEqual(new Set(["500"]));
  });

  it("maps Fortnox errors with a hint", async () => {
    const m = mockFetch(() => ({ status: 403, json: { ErrorInformation: { error: 1, message: "Saknar behörighet", code: 2000663 } } }));
    const mcp = await connect(m.fn);
    const r: any = await call(mcp, "get_invoice", { document_number: "1" });
    expect(r.isError).toBe(true);
    const e = json(r).error;
    expect(e.code).toBe(2000663);
    expect(e.hint).toMatch(/scope/i);
  });

  it("buckets receivables by days overdue", async () => {
    const m = mockFetch(() => ({
      json: {
        MetaInformation: { "@TotalPages": 1, "@TotalResources": 4 },
        Invoices: [
          { DocumentNumber: "1", CustomerName: "A", Balance: 100, DueDate: "2026-10-20", Currency: "SEK" },
          { DocumentNumber: "2", CustomerName: "A", Balance: 200, DueDate: "2026-09-30", Currency: "SEK" },
          { DocumentNumber: "3", CustomerName: "B", Balance: 300, DueDate: "2026-06-01", Currency: "SEK" },
          { DocumentNumber: "4", CustomerName: "C", Balance: 50, DueDate: "2026-06-01", Currency: "EUR" },
        ],
      },
    }));
    const mcp = await connect(m.fn);
    const r = json(await call(mcp, "receivables_aging", { as_of: "2026-10-15" }));
    expect(r.buckets).toEqual({ not_due: 100, "1_30": 200, "31_60": 0, "61_90": 0, over_90: 300 });
    expect(r.total).toBe(600);
    expect(r.other_currencies_unbucketed).toEqual({ EUR: 50 });
    expect(r.most_overdue[0].DocumentNumber).toBe("3");
  });
});

describe("fortnox_get allowlist", () => {
  it("matches real read paths", () => {
    expect(matchGetPath("/3/assets")).toBe("/3/assets");
    expect(matchGetPath("/3/employees/12")).toBe("/3/employees/{EmployeeId}");
    expect(matchGetPath("/3/prices/A/1001")).toBe("/3/prices/{PriceList}/{ArticleNumber}");
  });

  it("blocks endpoints that send, print or leave the allowlist", () => {
    for (const p of ["/3/invoices/1/email", "/3/invoices/1/eprint", "/3/invoices/1/print", "/3/sie/4", "/3/archive/abc", "/3/../3/invoices", "/3/invoices?x=1", "/api/integration-developer/ratings-v1", "https://evil.example/3/invoices"]) {
      expect(matchGetPath(p), p).toBeUndefined();
    }
  });

  it("refuses a blocked path without calling Fortnox", async () => {
    const m = mockFetch(() => ({ json: {} }));
    const mcp = await connect(m.fn);
    const r: any = await call(mcp, "fortnox_get", { path: "/3/invoices/5/email" });
    expect(r.isError).toBe(true);
    expect(m.calls).toHaveLength(0);
  });
});

describe("writes", () => {
  it("previews without calling Fortnox, then creates an unbooked draft on confirm", async () => {
    const m = mockFetch((c) => ({ json: { Invoice: { DocumentNumber: "900", CustomerNumber: c.body?.Invoice?.CustomerNumber, Booked: false, Sent: false, Total: 1250, Net: 1000, TotalVAT: 250 } } }));
    const mcp = await connect(m.fn, true);
    const args = { customer_number: "7", rows: [{ description: "Konsulttimmar", quantity: 10, price: 100, vat: 25 }] };

    const dry = json(await call(mcp, "create_invoice_draft", args));
    expect(dry.dry_run).toBe(true);
    expect(m.calls).toHaveLength(0);
    expect(dry.body.Invoice.InvoiceRows[0]).toEqual({ Description: "Konsulttimmar", DeliveredQuantity: 10, Price: 100, VAT: 25 });

    const done = json(await call(mcp, "create_invoice_draft", { ...args, confirm: true }));
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.url.pathname).toBe("/3/invoices");
    expect(done.DocumentNumber).toBe("900");
    expect(done.Booked).toBe(false);
  });

  it("does not retry a POST on a 5xx (it may already have been created)", async () => {
    const m = mockFetch(() => ({ status: 503, json: { message: "down" } }));
    const mcp = await connect(m.fn, true);
    const r: any = await call(mcp, "create_customer", { name: "Acme AB", confirm: true });
    expect(r.isError).toBe(true);
    expect(m.calls).toHaveLength(1);
  });
});

describe("reports from SIE", () => {
  const SIE = [
    "#FLAGGA 0",
    '#FNAMN "Test AB"',
    "#RAR 0 20260101 20261231",
    '#KONTO 1930 "Företagskonto"',
    '#KONTO 2081 "Aktiekapital"',
    '#KONTO 2611 "Utgående moms 25%"',
    '#KONTO 3001 "Försäljning"',
    '#KONTO 5010 "Lokalhyra"',
    "#IB 0 1930 25000.00",
    "#IB 0 2081 -25000.00",
    '#VER A 1 20260115 "Faktura 1"',
    "{",
    "#TRANS 1930 {} 12500.00",
    "#TRANS 3001 {} -10000.00",
    "#TRANS 2611 {} -2500.00",
    "}",
    '#VER A 2 20260201 "Hyra"',
    "{",
    "#TRANS 5010 {} 4000.00",
    "#TRANS 1930 {} -4000.00",
    "}",
    '#VER A 3 20260301 "Faktura 2"',
    "{",
    "#TRANS 1930 {} 5000.00",
    "#TRANS 3001 {} -5000.00",
    "}",
  ].join("\r\n");

  function sieFetch() {
    return mockFetch((c) => {
      if (c.url.pathname === "/3/financialyears") return { json: { FinancialYears: [{ Id: 3, FromDate: "2026-01-01", ToDate: "2026-12-31" }] } };
      if (c.url.pathname === "/3/sie/4") {
        // CP437: ö = 0x94
        const bytes = Uint8Array.from(Buffer.from(SIE, "latin1")).map((b) => (b === 0xf6 ? 0x94 : b));
        return { bytes };
      }
      return { status: 404, json: {} };
    });
  }

  it("builds an income statement for a date range", async () => {
    const m = sieFetch();
    const mcp = await connect(m.fn);
    const r = json(await call(mcp, "income_statement", { from_date: "2026-01-01", to_date: "2026-02-28" }));
    const revenue = r.groups.find((g: any) => g.key === "revenue");
    expect(revenue.total).toBe(10000);
    expect(r.groups.find((g: any) => g.key === "external").total).toBe(-4000);
    expect(r.net_result).toBe(6000);
    expect(r.groups.find((g: any) => g.key === "external").accounts[0].name).toBe("Lokalhyra");
    expect(m.calls.find((c) => c.url.pathname === "/3/sie/4")!.url.searchParams.get("financialyear")).toBe("3");
  });

  it("builds a balance sheet that balances, and caches the SIE file", async () => {
    const m = sieFetch();
    const mcp = await connect(m.fn);
    const r = json(await call(mcp, "balance_sheet", { date: "2026-12-31" }));
    expect(r.assets.total).toBe(38500);
    expect(r.equity_and_liabilities.total).toBe(r.assets.total);
    expect(r.unclosed_result).toBe(11000);
    await call(mcp, "account_totals_by_month", { from_date: "2026-01-01", to_date: "2026-12-31", account_from: 3000, account_to: 3999 });
    expect(m.calls.filter((c) => c.url.pathname === "/3/sie/4")).toHaveLength(1);
  });
});
