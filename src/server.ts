// The MCP server factory: Fortnox tools on @modelcontextprotocol/sdk.
//
// Three layers:
//   1. Curated read tools for what finance teams ask about every week
//      (invoices, supplier invoices, customers, vouchers, accounts…), returning
//      compact rows instead of Fortnox's 80-field objects.
//   2. Computed reports Fortnox has no endpoint for: income statement, balance
//      sheet, receivables/payables ageing, monthly account totals. Built from
//      one SIE 4 export per financial year rather than thousands of calls.
//   3. fortnox_get, a read-only escape hatch to every other GET endpoint in
//      Fortnox's published API, checked against an allowlist (src/paths.ts).
//
// Write tools exist only when FORTNOX_ENABLE_WRITES=true, and even then they
// create DRAFTS: an invoice is created unbooked and unsent, nothing is
// bookkept, paid, sent or deleted from here. Each write returns a preview
// unless called with confirm: true.
//
// Endpoints and fields follow Fortnox's API reference: https://apps.fortnox.se/apidocs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writesEnabled } from "./config.js";
import { createFortnoxClient, FortnoxApiError, redact, type FortnoxClient, type Query } from "./fortnox.js";
import { GET_PATHS } from "./paths.js";
import { balanceSheet, decodeCp437, incomeStatement, monthlyTotals, parseSie, type SieFile } from "./sie.js";
import { FortnoxAuthError } from "./tokens.js";

export const VERSION = "0.1.0";

export const INSTRUCTIONS =
  "MCP server for Fortnox, the Swedish accounting system. Amounts are in the document's own " +
  "currency (usually SEK), as decimal numbers, and invoice Total includes VAT; use get_invoice " +
  "for Net (excluding VAT). Dates are YYYY-MM-DD. Customer, supplier, invoice and article numbers " +
  "are per company. For financial questions (result, revenue, costs, cash, balance) prefer the " +
  "report tools (income_statement, balance_sheet, account_totals_by_month, receivables_aging, " +
  "payables_aging) over summing lists yourself. Account numbers follow the Swedish BAS chart: " +
  "1xxx assets, 2xxx equity and liabilities, 3xxx revenue, 4xxx–8xxx costs. For anything the " +
  "curated tools do not cover, call list_endpoints and then fortnox_get. Answer in the user's language.";

const MAX_TEXT = 300_000;

// ---------- shared schemas ----------

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const max = z.number().int().min(1).max(2000).optional().describe("Max rows to return (default 100, up to 2000)");
const confirm = z.boolean().optional().describe(
  "false/omitted returns a preview of exactly what would be sent. Set true only after the user has approved the preview.",
);

// ---------- helpers ----------

const enc = encodeURIComponent;

function jsonResult(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT) + `\n\n[truncated: ${text.length - MAX_TEXT} more characters. Narrow the request.]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(e: unknown) {
  if (e instanceof FortnoxApiError) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: e.toJSON() }, null, 2) }] };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: redact(msg) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    return errorResult(e);
  }
}

/** Keep only the listed keys that are present. */
function pick<T extends Record<string, unknown>>(o: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") out[k] = o[k];
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

// Compact projections of list rows.
const INVOICE_ROW = ["DocumentNumber", "CustomerNumber", "CustomerName", "InvoiceDate", "DueDate", "Total", "Balance", "Currency", "Booked", "Cancelled", "Sent", "OCR", "FinalPayDate"];
const SUPPLIER_INVOICE_ROW = ["GivenNumber", "SupplierNumber", "SupplierName", "InvoiceNumber", "InvoiceDate", "DueDate", "Total", "Balance", "Currency", "Booked", "Cancelled", "OCR", "FinalPayDate"];
const CUSTOMER_ROW = ["CustomerNumber", "Name", "OrganisationNumber", "Email", "Phone", "City", "ZipCode", "Active"];
const SUPPLIER_ROW = ["SupplierNumber", "Name", "OrganisationNumber", "Email", "Phone", "City", "Active"];
const ARTICLE_ROW = ["ArticleNumber", "Description", "SalesPrice", "PurchasePrice", "QuantityInStock", "Unit", "Active", "WebshopArticle"];
const ORDER_ROW = ["DocumentNumber", "CustomerNumber", "CustomerName", "OrderDate", "DeliveryDate", "Total", "Currency", "Cancelled", "Sent", "InvoiceReference"];
const OFFER_ROW = ["DocumentNumber", "CustomerNumber", "CustomerName", "OfferDate", "ExpireDate", "Total", "Currency", "Cancelled", "Sent", "OrderReference", "InvoiceReference"];
const VOUCHER_ROW = ["VoucherSeries", "VoucherNumber", "Year", "TransactionDate", "Description", "ReferenceType", "ReferenceNumber"];
const ACCOUNT_ROW = ["Number", "Description", "Active", "BalanceBroughtForward", "BalanceCarriedForward", "SRU", "VATCode", "Year"];

interface FinancialYear { Id: number; FromDate: string; ToDate: string; AccountChartType?: string }

// ---------- endpoint allowlist ----------

const TEMPLATES = GET_PATHS.map(([template, summary]) => ({
  template,
  summary,
  re: new RegExp("^" + template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, "[^/?#]+") + "$"),
}));

/** The allowlisted template a concrete path matches, or undefined. */
export function matchGetPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.includes("..") || path.includes("?") || path.includes("#")) return undefined;
  return TEMPLATES.find((t) => t.re.test(path))?.template;
}

// ---------- factory ----------

export interface CreateServerOptions {
  client?: FortnoxClient;
  /** Defaults to FORTNOX_ENABLE_WRITES === "true". */
  enableWrites?: boolean;
}

export function createFortnoxServer(opts: CreateServerOptions = {}): McpServer {
  const client = opts.client ?? createFortnoxClient();
  const enableWrites = opts.enableWrites ?? writesEnabled();

  const server = new McpServer(
    { name: "fortnox", version: VERSION },
    {
      instructions:
        INSTRUCTIONS +
        (enableWrites
          ? " Write tools are ENABLED but only create drafts; always show the preview (confirm omitted) and get the user's approval before calling again with confirm: true."
          : " This server is read-only."),
    },
  );

  // Financial years and SIE files are cached per server instance: a report
  // question usually needs the same year two or three times in a row.
  let yearsCache: FinancialYear[] | null = null;
  const sieCache = new Map<number, Promise<SieFile>>();

  async function financialYears(): Promise<FinancialYear[]> {
    if (!yearsCache) {
      const r = await client.get<{ FinancialYears?: FinancialYear[] }>("/3/financialyears");
      yearsCache = (r.FinancialYears ?? []).sort((a, b) => a.FromDate.localeCompare(b.FromDate));
    }
    return yearsCache;
  }

  async function yearsCovering(from: string, to: string): Promise<FinancialYear[]> {
    const ys = (await financialYears()).filter((y) => y.ToDate >= from && y.FromDate <= to);
    if (!ys.length) throw new Error(`No financial year in Fortnox covers ${from}–${to}. Call list_financial_years.`);
    return ys;
  }

  function sie(year: FinancialYear): Promise<SieFile> {
    let p = sieCache.get(year.Id);
    if (!p) {
      p = client.getBytes("/3/sie/4", { financialyear: year.Id }).then((b) => parseSie(decodeCp437(b)));
      p.catch(() => sieCache.delete(year.Id));
      sieCache.set(year.Id, p);
    }
    return p;
  }

  // ===== company =====

  server.registerTool("get_company_info", {
    title: "Company, financial years and locked period",
    description:
      "Who the connected Fortnox company is (name, org number, address, VAT number), its financial years, " +
      "and the locked period (the date through which the books are closed). Call this first to orient.",
    inputSchema: {},
    annotations: READ,
  }, async () => run(async () => {
    const settle = async <T>(p: Promise<T>) => p.then((v) => v, (e: unknown) => ({ error: e instanceof FortnoxApiError ? e.toJSON() : String(e) }));
    const [company, years, locked] = await Promise.all([
      settle(client.get<{ CompanyInformation?: Record<string, unknown> }>("/3/companyinformation").then((r) => r.CompanyInformation)),
      settle(financialYears()),
      settle(client.get<{ LockedPeriod?: { EndDate?: string } }>("/3/settings/lockedperiod").then((r) => r.LockedPeriod?.EndDate ?? null)),
    ]);
    return { company, financial_years: years, locked_through: locked };
  }));

  server.registerTool("list_financial_years", {
    title: "List financial years",
    description: "All financial years (räkenskapsår) with id and date range. The id is what SIE and voucher calls take.",
    inputSchema: {},
    annotations: READ,
  }, async () => run(() => financialYears()));

  // ===== customer invoices =====

  server.registerTool("list_invoices", {
    title: "List customer invoices",
    description:
      "Customer invoices (kundfakturor), newest first unless sorted otherwise. Filter by status " +
      "(unpaid, unpaidoverdue, fullypaid, unbooked, cancelled), invoice date range and customer. " +
      "Total includes VAT; Balance is the amount still unpaid according to Fortnox.",
    inputSchema: {
      filter: z.enum(["cancelled", "fullypaid", "unpaid", "unpaidoverdue", "unbooked"]).optional(),
      from_date: date.optional().describe("Invoice date from (inclusive)"),
      to_date: date.optional().describe("Invoice date to (inclusive)"),
      customer_number: z.string().optional(),
      sort_by: z.enum(["customername", "customernumber", "documentnumber", "invoicedate", "ocr", "total"]).optional(),
      sort_order: z.enum(["ascending", "descending"]).optional(),
      max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/invoices", "Invoices", {
      filter: a.filter, fromdate: a.from_date, todate: a.to_date, customernumber: a.customer_number,
      sortby: a.sort_by ?? "invoicedate", sortorder: a.sort_order ?? "descending",
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, invoices: r.items.map((i) => pick(i, INVOICE_ROW)) };
  }));

  server.registerTool("get_invoice", {
    title: "Get customer invoice",
    description: "One customer invoice in full: rows, Net (excl. VAT), VAT, Balance, due date, references, booked/sent state.",
    inputSchema: { document_number: z.string().min(1) },
    annotations: READ,
  }, async (a) => run(async () => (await client.get<{ Invoice: unknown }>(`/3/invoices/${enc(a.document_number)}`)).Invoice));

  server.registerTool("list_invoice_payments", {
    title: "List customer invoice payments",
    description: "Payments registered against customer invoices (inbetalningar). Optionally for one invoice.",
    inputSchema: { invoice_number: z.number().int().optional(), max },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/invoicepayments", "InvoicePayments", { invoicenumber: a.invoice_number }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, payments: r.items.map((p) => pick(p, ["Number", "InvoiceNumber", "InvoiceCustomerName", "Amount", "AmountCurrency", "Currency", "PaymentDate", "Booked", "Source"])) };
  }));

  // ===== supplier invoices =====

  server.registerTool("list_supplier_invoices", {
    title: "List supplier invoices",
    description:
      "Supplier invoices (leverantörsfakturor). Filter by status (unpaid, unpaidoverdue, fullypaid, " +
      "unbooked, cancelled, pendingpayment, authorizepending = awaiting attest), date range and supplier.",
    inputSchema: {
      filter: z.enum(["cancelled", "fullypaid", "unpaid", "unpaidoverdue", "unbooked", "pendingpayment", "authorizepending"]).optional(),
      from_date: date.optional(),
      to_date: date.optional(),
      supplier_number: z.string().optional(),
      max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/supplierinvoices", "SupplierInvoices", {
      filter: a.filter, fromdate: a.from_date, todate: a.to_date, suppliernumber: a.supplier_number,
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, supplier_invoices: r.items.map((i) => pick(i, SUPPLIER_INVOICE_ROW)) };
  }));

  server.registerTool("get_supplier_invoice", {
    title: "Get supplier invoice",
    description: "One supplier invoice in full, with its accounting rows. given_number is Fortnox's own serial number for it.",
    inputSchema: { given_number: z.string().min(1) },
    annotations: READ,
  }, async (a) => run(async () => (await client.get<{ SupplierInvoice: unknown }>(`/3/supplierinvoices/${enc(a.given_number)}`)).SupplierInvoice));

  // ===== registers =====

  server.registerTool("list_customers", {
    title: "List customers",
    description: "Customer register. Search by name, org number or email.",
    inputSchema: {
      name: z.string().optional(),
      organisation_number: z.string().optional(),
      email: z.string().optional(),
      filter: z.enum(["active", "inactive"]).optional(),
      max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/customers", "Customers", {
      name: a.name, organisationnumber: a.organisation_number, email: a.email, filter: a.filter, sortby: "name",
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, customers: r.items.map((c) => pick(c, CUSTOMER_ROW)) };
  }));

  server.registerTool("get_customer", {
    title: "Get customer",
    description: "One customer in full: addresses, terms of payment, VAT type, default references.",
    inputSchema: { customer_number: z.string().min(1) },
    annotations: READ,
  }, async (a) => run(async () => (await client.get<{ Customer: unknown }>(`/3/customers/${enc(a.customer_number)}`)).Customer));

  server.registerTool("list_suppliers", {
    title: "List suppliers",
    description: "Supplier register.",
    inputSchema: { max },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/suppliers", "Suppliers", {}, a.max ?? 200);
    return { total: r.total, truncated: r.truncated, suppliers: r.items.map((s) => pick(s, SUPPLIER_ROW)) };
  }));

  server.registerTool("get_supplier", {
    title: "Get supplier",
    description: "One supplier in full, including bank details as registered in Fortnox.",
    inputSchema: { supplier_number: z.string().min(1) },
    annotations: READ,
  }, async (a) => run(async () => (await client.get<{ Supplier: unknown }>(`/3/suppliers/${enc(a.supplier_number)}`)).Supplier));

  server.registerTool("list_articles", {
    title: "List articles",
    description: "Article (product/service) register with prices and stock.",
    inputSchema: { description: z.string().optional(), filter: z.enum(["active", "inactive"]).optional(), max },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/articles", "Articles", { description: a.description, filter: a.filter }, a.max ?? 200);
    return { total: r.total, truncated: r.truncated, articles: r.items.map((x) => pick(x, ARTICLE_ROW)) };
  }));

  server.registerTool("list_orders", {
    title: "List orders",
    description: "Customer orders. Filter invoicenotcreated shows orders not yet invoiced.",
    inputSchema: {
      filter: z.enum(["cancelled", "expired", "invoicecreated", "invoicenotcreated"]).optional(),
      from_date: date.optional(), to_date: date.optional(), customer_number: z.string().optional(), max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/orders", "Orders", {
      filter: a.filter, fromdate: a.from_date, todate: a.to_date, customernumber: a.customer_number,
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, orders: r.items.map((o) => pick(o, ORDER_ROW)) };
  }));

  server.registerTool("list_offers", {
    title: "List offers",
    description: "Quotes/offers (offerter).",
    inputSchema: {
      filter: z.enum(["cancelled", "expired", "completed", "notcompleted", "ordercreated", "ordernotcreated"]).optional(),
      from_date: date.optional(), to_date: date.optional(), customer_number: z.string().optional(), max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/offers", "Offers", {
      filter: a.filter, fromdate: a.from_date, todate: a.to_date, customernumber: a.customer_number,
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, offers: r.items.map((o) => pick(o, OFFER_ROW)) };
  }));

  server.registerTool("list_projects", {
    title: "List projects",
    description: "Projects, used to tag invoices, vouchers and costs.",
    inputSchema: { max },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/projects", "Projects", {}, a.max ?? 200);
    return { total: r.total, projects: r.items.map((p) => pick(p, ["ProjectNumber", "Description", "Status", "StartDate", "EndDate", "ProjectLeader", "CustomerNumber"])) };
  }));

  server.registerTool("list_cost_centers", {
    title: "List cost centers",
    description: "Cost centers (kostnadsställen).",
    inputSchema: {},
    annotations: READ,
  }, async () => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/costcenters", "CostCenters", {}, 500);
    return r.items.map((c) => pick(c, ["Code", "Description", "Active", "Note"]));
  }));

  // ===== bookkeeping =====

  server.registerTool("list_accounts", {
    title: "List accounts",
    description: "Chart of accounts (kontoplan) for a financial year, with opening (BalanceBroughtForward) and closing (BalanceCarriedForward) balances.",
    inputSchema: {
      financial_year: z.number().int().optional().describe("Financial year id from list_financial_years; default the current year"),
      only_used: z.boolean().optional().describe("Skip accounts with zero balances (default true)"),
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/accounts", "Accounts", { financialyear: a.financial_year }, 2000);
    let rows = r.items.map((x) => pick(x, ACCOUNT_ROW));
    if (a.only_used ?? true) rows = rows.filter((x) => Number(x.BalanceBroughtForward ?? 0) !== 0 || Number(x.BalanceCarriedForward ?? 0) !== 0);
    return rows;
  }));

  server.registerTool("list_vouchers", {
    title: "List vouchers",
    description:
      "Vouchers (verifikationer) by date range or series. Rows are not included; use get_voucher for one, or the " +
      "report tools for totals.",
    inputSchema: {
      financial_year: z.number().int().optional(),
      from_date: date.optional(), to_date: date.optional(),
      series: z.string().max(4).optional().describe("Voucher series, e.g. A"),
      max,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const path = a.series ? `/3/vouchers/sublist/${enc(a.series)}` : "/3/vouchers";
    const r = await client.list<Record<string, unknown>>(path, "Vouchers", {
      financialyear: a.financial_year, fromdate: a.from_date, todate: a.to_date,
    }, a.max ?? 100);
    return { total: r.total, truncated: r.truncated, vouchers: r.items.map((v) => pick(v, VOUCHER_ROW)) };
  }));

  server.registerTool("get_voucher", {
    title: "Get voucher",
    description: "One voucher with its debit/credit rows.",
    inputSchema: { series: z.string().min(1).max(4), number: z.number().int(), financial_year: z.number().int().optional() },
    annotations: READ,
  }, async (a) => run(async () => (await client.get<{ Voucher: unknown }>(
    `/3/vouchers/${enc(a.series)}/${a.number}`, { financialyear: a.financial_year },
  )).Voucher));

  // ===== reports =====

  server.registerTool("income_statement", {
    title: "Income statement (resultaträkning)",
    description:
      "Profit and loss for any date range, grouped by BAS account class with per-account lines: revenue, goods, " +
      "external costs, personnel, depreciation, financial items, tax. Revenue positive, costs negative. Built from " +
      "the SIE export, so it matches the books exactly, including manual vouchers.",
    inputSchema: { from_date: date, to_date: date },
    annotations: READ,
  }, async (a) => run(async () => {
    const files = await Promise.all((await yearsCovering(a.from_date, a.to_date)).map(sie));
    return { currency: "SEK", ...incomeStatement(files, a.from_date, a.to_date) };
  }));

  server.registerTool("balance_sheet", {
    title: "Balance sheet (balansräkning)",
    description:
      "Assets, equity and liabilities on a date, per account, plus the year's result not yet closed to equity. " +
      "Cash and bank are the 19xx accounts.",
    inputSchema: { date: date.optional().describe("Default today") },
    annotations: READ,
  }, async (a) => run(async () => {
    const d = a.date ?? today();
    const [year] = await yearsCovering(d, d);
    return { currency: "SEK", ...balanceSheet(await sie(year!), d) };
  }));

  server.registerTool("account_totals_by_month", {
    title: "Account totals by month",
    description:
      "Monthly net movement for an account range, e.g. 3000–3999 for revenue per month, 5000–6999 for external " +
      "costs, 7000–7699 for personnel, 1930–1930 for the business account. Revenue accounts (3xxx+) are " +
      "sign-flipped so income reads positive.",
    inputSchema: {
      from_date: date, to_date: date,
      account_from: z.number().int().min(1000).max(8999),
      account_to: z.number().int().min(1000).max(8999),
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const files = await Promise.all((await yearsCovering(a.from_date, a.to_date)).map(sie));
    return { currency: "SEK", accounts: `${a.account_from}–${a.account_to}`, months: monthlyTotals(files, a.from_date, a.to_date, a.account_from, a.account_to) };
  }));

  function aging(rows: Record<string, unknown>[], asOf: string, party: "CustomerName" | "SupplierName") {
    const buckets = { not_due: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 };
    const byParty = new Map<string, number>();
    const other: Record<string, number> = {};
    const overdue: Record<string, unknown>[] = [];
    for (const r of rows) {
      const balance = Number(r.Balance ?? 0);
      if (!balance || r.Cancelled) continue;
      const currency = String(r.Currency ?? "SEK");
      if (currency !== "SEK") { other[currency] = round((other[currency] ?? 0) + balance); continue; }
      const late = r.DueDate ? daysBetween(String(r.DueDate), asOf) : 0;
      const key = late <= 0 ? "not_due" : late <= 30 ? "1_30" : late <= 60 ? "31_60" : late <= 90 ? "61_90" : "over_90";
      buckets[key] = round(buckets[key] + balance);
      byParty.set(String(r[party] ?? "?"), round((byParty.get(String(r[party] ?? "?")) ?? 0) + balance));
      if (late > 0) overdue.push({ ...r, days_overdue: late });
    }
    return {
      as_of: asOf,
      currency: "SEK",
      total: round(Object.values(buckets).reduce((n, v) => n + v, 0)),
      buckets,
      by_counterparty: [...byParty.entries()].map(([name, amount]) => ({ name, amount })).sort((x, y) => y.amount - x.amount).slice(0, 25),
      most_overdue: overdue.sort((x, y) => Number(y.days_overdue) - Number(x.days_overdue)).slice(0, 25),
      ...(Object.keys(other).length ? { other_currencies_unbucketed: other } : {}),
    };
  }

  server.registerTool("receivables_aging", {
    title: "Accounts receivable ageing (kundreskontra)",
    description: "Unpaid customer invoices bucketed by days past due (not due, 1–30, 31–60, 61–90, 90+), per customer, with the most overdue invoices.",
    inputSchema: { as_of: date.optional().describe("Default today") },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/invoices", "Invoices", { filter: "unpaid" }, 2000);
    return { ...aging(r.items.map((i) => pick(i, INVOICE_ROW)), a.as_of ?? today(), "CustomerName"), truncated: r.truncated };
  }));

  server.registerTool("payables_aging", {
    title: "Accounts payable ageing (leverantörsreskontra)",
    description: "Unpaid supplier invoices bucketed by days past due, per supplier, with the most overdue.",
    inputSchema: { as_of: date.optional().describe("Default today") },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.list<Record<string, unknown>>("/3/supplierinvoices", "SupplierInvoices", { filter: "unpaid" }, 2000);
    return { ...aging(r.items.map((i) => pick(i, SUPPLIER_INVOICE_ROW)), a.as_of ?? today(), "SupplierName"), truncated: r.truncated };
  }));

  // ===== everything else, read-only =====

  server.registerTool("list_endpoints", {
    title: "List Fortnox read endpoints",
    description:
      "Search the read-only Fortnox endpoints fortnox_get can call (assets, contracts, employees, salary, time, " +
      "warehouse, price lists, currencies, …). Returns path templates and summaries.",
    inputSchema: { search: z.string().optional().describe("Word to match in the path or summary, e.g. 'asset', 'salary', 'price'") },
    annotations: READ,
  }, async (a) => run(async () => {
    const q = a.search?.toLowerCase();
    return GET_PATHS.filter(([p, s]) => !q || p.toLowerCase().includes(q) || s.toLowerCase().includes(q)).map(([path, summary]) => ({ path, summary }));
  }));

  server.registerTool("fortnox_get", {
    title: "Read any Fortnox endpoint",
    description:
      "GET a Fortnox API path that matches one of the templates from list_endpoints, with {placeholders} filled in, " +
      "e.g. /3/assets or /3/employees/12. Read-only: nothing that sends, prints or changes data is reachable.",
    inputSchema: {
      path: z.string().min(2).describe("Concrete path, e.g. /3/pricelists/A"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters, e.g. {\"limit\": 100}"),
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const template = matchGetPath(a.path);
    if (!template) throw new Error(`Path not allowed: ${a.path}. Call list_endpoints to see readable paths.`);
    return client.get(a.path, a.query as Query | undefined);
  }));

  if (!enableWrites) return server;

  // ===== writes: drafts only =====

  async function preview(confirmed: boolean | undefined, what: string, path: string, body: unknown, send: () => Promise<unknown>) {
    if (!confirmed) {
      return {
        dry_run: true,
        would: `POST ${path}`,
        what,
        body,
        next: "Show this to the user. If they approve, call the same tool again with the same arguments and confirm: true.",
      };
    }
    return send();
  }

  const row = z.object({
    article_number: z.string().optional(),
    description: z.string().max(255).optional(),
    quantity: z.number().min(0),
    price: z.number().describe("Unit price excl. VAT unless the customer is set to VAT-included prices"),
    account_number: z.number().int().optional().describe("Sales account, e.g. 3001; default from article/settings"),
    vat: z.number().int().optional().describe("VAT percent, e.g. 25"),
    unit: z.string().optional(),
  });

  server.registerTool("create_customer", {
    title: "Create customer",
    description: "Add a customer to the register. Preview first; confirm: true to create.",
    inputSchema: {
      name: z.string().min(1),
      organisation_number: z.string().optional(),
      type: z.enum(["COMPANY", "PRIVATE"]).optional(),
      email: z.string().email().optional(),
      email_invoice: z.string().email().optional(),
      address1: z.string().optional(), zip_code: z.string().optional(), city: z.string().optional(),
      country_code: z.string().length(2).optional(),
      vat_number: z.string().optional(),
      our_reference: z.string().optional(), your_reference: z.string().optional(),
      terms_of_payment: z.string().optional().describe("Code, e.g. 30"),
      confirm,
    },
    annotations: WRITE,
  }, async (a) => run(async () => {
    const body = {
      Customer: pick({
        Name: a.name, OrganisationNumber: a.organisation_number, Type: a.type, Email: a.email, EmailInvoice: a.email_invoice,
        Address1: a.address1, ZipCode: a.zip_code, City: a.city, CountryCode: a.country_code, VATNumber: a.vat_number,
        OurReference: a.our_reference, YourReference: a.your_reference, TermsOfPayment: a.terms_of_payment,
      }, ["Name", "OrganisationNumber", "Type", "Email", "EmailInvoice", "Address1", "ZipCode", "City", "CountryCode", "VATNumber", "OurReference", "YourReference", "TermsOfPayment"]),
    };
    return preview(a.confirm, `New customer "${a.name}"`, "/3/customers", body,
      async () => pick((await client.post<{ Customer: Record<string, unknown> }>("/3/customers", body)).Customer, CUSTOMER_ROW));
  }));

  const docRows = (rows: z.infer<typeof row>[], qtyField: "DeliveredQuantity" | "OrderedQuantity" | "Quantity") =>
    rows.map((r) => pick({
      ArticleNumber: r.article_number, Description: r.description, [qtyField]: r.quantity, Price: r.price,
      AccountNumber: r.account_number, VAT: r.vat, Unit: r.unit,
    }, ["ArticleNumber", "Description", qtyField, "Price", "AccountNumber", "VAT", "Unit"]));

  const docInput = {
    customer_number: z.string().min(1),
    rows: z.array(row).min(1).max(200),
    your_reference: z.string().optional(),
    our_reference: z.string().optional(),
    your_order_number: z.string().optional(),
    currency: z.string().length(3).optional(),
    comments: z.string().max(1024).optional(),
    project: z.string().optional(),
    cost_center: z.string().optional(),
    confirm,
  };

  server.registerTool("create_invoice_draft", {
    title: "Create invoice draft",
    description:
      "Create a customer invoice as an unbooked, unsent DRAFT for a person to review, book and send in Fortnox. " +
      "Nothing is bookkept or emailed. Preview first; confirm: true to create.",
    inputSchema: {
      ...docInput,
      invoice_date: date.optional().describe("Default today"),
      due_date: date.optional().describe("Default from the customer's terms of payment"),
    },
    annotations: WRITE,
  }, async (a) => run(async () => {
    const body = {
      Invoice: {
        ...pick({
          CustomerNumber: a.customer_number, InvoiceDate: a.invoice_date, DueDate: a.due_date, YourReference: a.your_reference,
          OurReference: a.our_reference, YourOrderNumber: a.your_order_number, Currency: a.currency, Remarks: a.comments,
          Project: a.project, CostCenter: a.cost_center,
        }, ["CustomerNumber", "InvoiceDate", "DueDate", "YourReference", "OurReference", "YourOrderNumber", "Currency", "Remarks", "Project", "CostCenter"]),
        InvoiceRows: docRows(a.rows, "DeliveredQuantity"),
      },
    };
    return preview(a.confirm, `Invoice draft for customer ${a.customer_number} (not booked, not sent)`, "/3/invoices", body, async () => {
      const inv = (await client.post<{ Invoice: Record<string, unknown> }>("/3/invoices", body)).Invoice;
      return { ...pick(inv, [...INVOICE_ROW, "Net", "TotalVAT"]), note: "Draft created. Review, book and send it in Fortnox." };
    });
  }));

  server.registerTool("create_offer", {
    title: "Create offer",
    description: "Create a quote/offer (offert) for a customer. Not sent. Preview first; confirm: true to create.",
    inputSchema: { ...docInput, offer_date: date.optional(), expire_date: date.optional() },
    annotations: WRITE,
  }, async (a) => run(async () => {
    const body = {
      Offer: {
        ...pick({
          CustomerNumber: a.customer_number, OfferDate: a.offer_date, ExpireDate: a.expire_date, YourReference: a.your_reference,
          OurReference: a.our_reference, Currency: a.currency, Remarks: a.comments, Project: a.project, CostCenter: a.cost_center,
        }, ["CustomerNumber", "OfferDate", "ExpireDate", "YourReference", "OurReference", "Currency", "Remarks", "Project", "CostCenter"]),
        OfferRows: docRows(a.rows, "Quantity"),
      },
    };
    return preview(a.confirm, `Offer for customer ${a.customer_number} (not sent)`, "/3/offers", body,
      async () => pick((await client.post<{ Offer: Record<string, unknown> }>("/3/offers", body)).Offer, OFFER_ROW));
  }));

  server.registerTool("create_order", {
    title: "Create order",
    description: "Create a customer order. Not invoiced or sent. Preview first; confirm: true to create.",
    inputSchema: { ...docInput, order_date: date.optional(), delivery_date: date.optional() },
    annotations: WRITE,
  }, async (a) => run(async () => {
    const body = {
      Order: {
        ...pick({
          CustomerNumber: a.customer_number, OrderDate: a.order_date, DeliveryDate: a.delivery_date, YourReference: a.your_reference,
          OurReference: a.our_reference, YourOrderNumber: a.your_order_number, Currency: a.currency, Remarks: a.comments,
          Project: a.project, CostCenter: a.cost_center,
        }, ["CustomerNumber", "OrderDate", "DeliveryDate", "YourReference", "OurReference", "YourOrderNumber", "Currency", "Remarks", "Project", "CostCenter"]),
        OrderRows: docRows(a.rows, "OrderedQuantity"),
      },
    };
    return preview(a.confirm, `Order for customer ${a.customer_number}`, "/3/orders", body,
      async () => pick((await client.post<{ Order: Record<string, unknown> }>("/3/orders", body)).Order, ORDER_ROW));
  }));

  return server;
}

export { FortnoxAuthError };
