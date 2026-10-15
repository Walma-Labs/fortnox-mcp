// SIE 4: a whole financial year of bookkeeping in one file.
//
// Fortnox has no income-statement or balance-sheet endpoint. Building them from
// /3/vouchers costs one request per voucher (rows are only on the detail view),
// so a year with a thousand vouchers is four minutes of rate-limited calls.
// GET /3/sie/4 returns the same data in a single request.
//
// Pure parsing and summing, no I/O.

/** CP437 ("#FORMAT PC8"), bytes 128–255. SIE mandates it and TextDecoder can't decode it. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
  return out;
}

/** Split a SIE line into fields: quoted strings with \" escapes, {object lists} as one field. */
export function tokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === " " || c === "\t") {
      i++;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        s += line[i++];
      }
      out.push(s);
      i++;
    } else if (c === "{") {
      const end = line.indexOf("}", i);
      out.push(line.slice(i, end < 0 ? undefined : end + 1));
      i = end < 0 ? line.length : end + 1;
    } else {
      let s = "";
      while (i < line.length && line[i] !== " " && line[i] !== "\t") s += line[i++];
      out.push(s);
    }
  }
  return out;
}

export interface SieTransaction {
  account: number;
  /** YYYY-MM-DD. The row's own date if given, otherwise the voucher's. */
  date: string;
  /** Debit positive, credit negative. */
  amount: number;
  voucher: string;
  text: string;
}

export interface SieFile {
  company?: string;
  orgNumber?: string;
  /** Year 0 (the exported year): from/to, YYYY-MM-DD. */
  year?: { from: string; to: string };
  accounts: Map<number, string>;
  /** Opening balances for year 0. */
  opening: Map<number, number>;
  transactions: SieTransaction[];
}

const isoDate = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

export function parseSie(text: string): SieFile {
  const sie: SieFile = { accounts: new Map(), opening: new Map(), transactions: [] };
  let voucher = "";
  let voucherDate = "";
  let voucherText = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("#")) continue;
    const f = tokens(line);
    switch (f[0]) {
      case "#FNAMN":
        sie.company = f[1];
        break;
      case "#ORGNR":
        sie.orgNumber = f[1];
        break;
      case "#RAR":
        if (f[1] === "0" && f[2] && f[3]) sie.year = { from: isoDate(f[2]), to: isoDate(f[3]) };
        break;
      case "#KONTO":
        sie.accounts.set(Number(f[1]), f[2] ?? "");
        break;
      case "#IB":
        if (f[1] === "0") sie.opening.set(Number(f[2]), Number(f[3]));
        break;
      case "#VER":
        voucher = `${f[1]}${f[2]}`;
        voucherDate = isoDate(f[3] ?? "");
        voucherText = f[4] ?? "";
        break;
      case "#TRANS": {
        // #TRANS account {objects} amount [date] [text] ...
        const date = f[4] && /^\d{8}$/.test(f[4]) ? isoDate(f[4]) : voucherDate;
        sie.transactions.push({
          account: Number(f[1]),
          date,
          amount: Number(f[3]),
          voucher,
          text: f[5] || voucherText,
        });
        break;
      }
    }
  }
  return sie;
}

// ---------- reports ----------

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * BAS account-plan groups for a Swedish income statement. Revenue is shown
 * positive and costs negative, the way a Swedish resultaträkning reads.
 */
const INCOME_GROUPS: { key: string; label: string; from: number; to: number }[] = [
  { key: "revenue", label: "Rörelsens intäkter (3000–3999)", from: 3000, to: 3999 },
  { key: "goods", label: "Material och varor (4000–4999)", from: 4000, to: 4999 },
  { key: "external", label: "Övriga externa kostnader (5000–6999)", from: 5000, to: 6999 },
  { key: "personnel", label: "Personalkostnader (7000–7699)", from: 7000, to: 7699 },
  { key: "depreciation", label: "Av- och nedskrivningar (7700–7899)", from: 7700, to: 7899 },
  { key: "other_operating", label: "Övriga rörelsekostnader (7900–7999)", from: 7900, to: 7999 },
  { key: "financial", label: "Finansiella poster (8000–8799)", from: 8000, to: 8799 },
  { key: "appropriations", label: "Bokslutsdispositioner (8800–8899)", from: 8800, to: 8899 },
  { key: "tax", label: "Skatt och årets resultat (8900–8999)", from: 8900, to: 8999 },
];

export interface AccountLine {
  account: number;
  name: string;
  amount: number;
}

export interface IncomeStatement {
  from: string;
  to: string;
  groups: { key: string; label: string; total: number; accounts: AccountLine[] }[];
  operating_result: number;
  result_after_financial: number;
  net_result: number;
}

/** Sum transactions per account over [from, to] for the given account range. */
function sumAccounts(files: SieFile[], from: string, to: string, lo: number, hi: number): Map<number, number> {
  const sums = new Map<number, number>();
  for (const sie of files) {
    for (const t of sie.transactions) {
      if (t.account < lo || t.account > hi || t.date < from || t.date > to) continue;
      sums.set(t.account, (sums.get(t.account) ?? 0) + t.amount);
    }
  }
  return sums;
}

function accountName(files: SieFile[], account: number): string {
  for (const f of files) {
    const n = f.accounts.get(account);
    if (n) return n;
  }
  return "";
}

export function incomeStatement(files: SieFile[], from: string, to: string): IncomeStatement {
  const sums = sumAccounts(files, from, to, 3000, 8999);
  const groups = INCOME_GROUPS.map((g) => {
    const accounts: AccountLine[] = [];
    for (const [account, amount] of [...sums.entries()].sort((a, b) => a[0] - b[0])) {
      if (account < g.from || account > g.to || Math.abs(amount) < 0.005) continue;
      // Credit (negative) is income: flip so revenue reads positive.
      accounts.push({ account, name: accountName(files, account), amount: round(-amount) });
    }
    return { key: g.key, label: g.label, total: round(accounts.reduce((n, a) => n + a.amount, 0)), accounts };
  });
  const total = (...keys: string[]) => round(groups.filter((g) => keys.includes(g.key)).reduce((n, g) => n + g.total, 0));
  return {
    from,
    to,
    groups,
    operating_result: total("revenue", "goods", "external", "personnel", "depreciation", "other_operating"),
    result_after_financial: total("revenue", "goods", "external", "personnel", "depreciation", "other_operating", "financial"),
    net_result: total(...INCOME_GROUPS.map((g) => g.key)),
  };
}

export interface BalanceSheet {
  date: string;
  assets: { total: number; accounts: AccountLine[] };
  equity_and_liabilities: { total: number; accounts: AccountLine[] };
  /** Result of the year so far, not yet closed to equity. Balances the sheet. */
  unclosed_result: number;
}

/**
 * Balances on `date` from one financial year's file: opening balance plus
 * every transaction up to and including that date.
 */
export function balanceSheet(sie: SieFile, date: string): BalanceSheet {
  const bal = new Map<number, number>(sie.opening);
  let result = 0;
  for (const t of sie.transactions) {
    if (t.date > date) continue;
    if (t.account >= 1000 && t.account <= 2999) bal.set(t.account, (bal.get(t.account) ?? 0) + t.amount);
    else if (t.account >= 3000 && t.account <= 8999) result += t.amount;
  }
  const lines = (lo: number, hi: number, sign: number) =>
    [...bal.entries()]
      .filter(([a, v]) => a >= lo && a <= hi && Math.abs(v) >= 0.005)
      .sort((a, b) => a[0] - b[0])
      .map(([account, v]) => ({ account, name: sie.accounts.get(account) ?? "", amount: round(sign * v) }));
  const assets = lines(1000, 1999, 1);
  const eql = lines(2000, 2999, -1);
  return {
    date,
    assets: { total: round(assets.reduce((n, a) => n + a.amount, 0)), accounts: assets },
    equity_and_liabilities: { total: round(eql.reduce((n, a) => n + a.amount, 0) - result), accounts: eql },
    unclosed_result: round(-result),
  };
}

/** Monthly totals for an account range, e.g. revenue per month. Sign flipped for 3xxx. */
export function monthlyTotals(files: SieFile[], from: string, to: string, lo: number, hi: number): { month: string; amount: number }[] {
  const byMonth = new Map<string, number>();
  const flip = lo >= 3000 ? -1 : 1;
  for (const sie of files) {
    for (const t of sie.transactions) {
      if (t.account < lo || t.account > hi || t.date < from || t.date > to) continue;
      const m = t.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + flip * t.amount);
    }
  }
  return [...byMonth.entries()].sort().map(([month, amount]) => ({ month, amount: round(amount) }));
}
