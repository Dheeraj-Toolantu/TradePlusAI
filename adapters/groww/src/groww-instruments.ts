export const GROWW_INSTRUMENT_CSV_URL = "https://growwapi-assets.groww.in/instruments/instrument.csv";

export type GrowwInstrument = {
  exchange: string;
  exchangeToken: string;
  tradingSymbol: string;
  growwSymbol: string;
  name?: string;
  instrumentType?: string;
  segment: string;
  series?: string;
  isin?: string;
  underlyingSymbol?: string;
  underlyingExchangeToken?: string;
  expiryDate?: string;
  strikePrice?: number;
  lotSize?: number;
  tickSize?: number;
  freezeQuantity?: number;
  isReserved?: boolean;
  buyAllowed?: boolean;
  sellAllowed?: boolean;
};

function parseCsvRow(row: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"' && row[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(value.trim()); value = ""; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function optionalText(value: string | undefined): string | undefined {
  return value && value.toLowerCase() !== "nan" ? value : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  const normalized = optionalText(value);
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = optionalText(value);
  if (normalized === undefined) return undefined;
  return normalized === "1" || normalized.toLowerCase() === "true";
}

export function parseGrowwInstrumentsCsv(csv: string): GrowwInstrument[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvRow(lines[0]).map((header) => header.toLowerCase());
  const column = (row: string[], name: string) => row[headers.indexOf(name)];
  return lines.slice(1).map((line) => {
    const row = parseCsvRow(line);
    return {
      exchange: column(row, "exchange") ?? "",
      exchangeToken: column(row, "exchange_token") ?? "",
      tradingSymbol: column(row, "trading_symbol") ?? "",
      growwSymbol: column(row, "groww_symbol") ?? "",
      name: optionalText(column(row, "name")),
      instrumentType: optionalText(column(row, "instrument_type")),
      segment: column(row, "segment") ?? "",
      series: optionalText(column(row, "series")),
      isin: optionalText(column(row, "isin")),
      underlyingSymbol: optionalText(column(row, "underlying_symbol")),
      underlyingExchangeToken: optionalText(column(row, "underlying_exchange_token")),
      expiryDate: optionalText(column(row, "expiry_date")),
      strikePrice: optionalNumber(column(row, "strike_price")),
      lotSize: optionalNumber(column(row, "lot_size")),
      tickSize: optionalNumber(column(row, "tick_size")),
      freezeQuantity: optionalNumber(column(row, "freeze_quantity")),
      isReserved: optionalBoolean(column(row, "is_reserved")),
      buyAllowed: optionalBoolean(column(row, "buy_allowed")),
      sellAllowed: optionalBoolean(column(row, "sell_allowed")),
    };
  }).filter((instrument) => instrument.exchangeToken && instrument.tradingSymbol && instrument.growwSymbol);
}

export class GrowwInstrumentCatalog {
  private readonly byGrowwSymbol = new Map<string, GrowwInstrument>();
  private readonly byTradingSymbol = new Map<string, GrowwInstrument>();
  private readonly byExchangeToken = new Map<string, GrowwInstrument>();

  constructor(instruments: GrowwInstrument[]) {
    for (const instrument of instruments) {
      this.byGrowwSymbol.set(instrument.growwSymbol, instrument);
      this.byTradingSymbol.set(`${instrument.exchange}:${instrument.tradingSymbol}`, instrument);
      this.byExchangeToken.set(instrument.exchangeToken, instrument);
    }
  }

  getByGrowwSymbol(growwSymbol: string): GrowwInstrument | undefined { return this.byGrowwSymbol.get(growwSymbol); }
  getByTradingSymbol(exchange: string, tradingSymbol: string): GrowwInstrument | undefined { return this.byTradingSymbol.get(`${exchange}:${tradingSymbol}`); }
  getByExchangeToken(exchangeToken: string): GrowwInstrument | undefined { return this.byExchangeToken.get(exchangeToken); }
  getAll(): GrowwInstrument[] { return [...this.byGrowwSymbol.values()]; }
}

async function downloadCatalog(fetcher: typeof fetch, url: string): Promise<GrowwInstrumentCatalog> {
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Groww instruments download failed with HTTP ${response.status}`);
  return new GrowwInstrumentCatalog(parseGrowwInstrumentsCsv(await response.text()));
}

// The contract master is a multi-MB CSV that changes once a day. It was re-downloaded and
// re-parsed on every option-chain, market-intel, search and order request; cache it per
// server process for up to 6 hours within the same IST trading day, sharing in-flight loads.
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
type CatalogCache = { key: string; at: number; day: string; promise: Promise<GrowwInstrumentCatalog> };
const catalogGlobal = globalThis as typeof globalThis & { __tradepulseGrowwCatalog?: CatalogCache };
const istDay = (now: number) => new Date(now + 330 * 60_000).toISOString().slice(0, 10);

export async function loadGrowwInstrumentCatalog(fetcher: typeof fetch = fetch, url = process.env.GROWW_INSTRUMENTS_URL ?? GROWW_INSTRUMENT_CSV_URL): Promise<GrowwInstrumentCatalog> {
  if (fetcher !== fetch) return downloadCatalog(fetcher, url); // injected fetchers (tests) are never cached
  const now = Date.now();
  const cached = catalogGlobal.__tradepulseGrowwCatalog;
  if (cached && cached.key === url && cached.day === istDay(now) && now - cached.at < CATALOG_TTL_MS) return cached.promise;
  const promise = downloadCatalog(fetcher, url);
  catalogGlobal.__tradepulseGrowwCatalog = { key: url, at: now, day: istDay(now), promise };
  promise.catch(() => { if (catalogGlobal.__tradepulseGrowwCatalog?.promise === promise) catalogGlobal.__tradepulseGrowwCatalog = undefined; });
  return promise;
}