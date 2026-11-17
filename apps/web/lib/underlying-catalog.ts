import { loadGrowwInstrumentCatalog, type GrowwInstrument, type GrowwInstrumentCatalog } from "../../../adapters/groww/src/groww-instruments";
import { UNDERLYINGS, isCommodity } from "./underlyings";

/**
 * Derivative contracts for an underlying, read from Groww's instrument catalog (server only).
 *
 * Index underlyings keep the existing rules (segment FNO, NSE or BSE). For MCX commodities nothing
 * about Groww's symbol format or segment name is assumed: the option and future rows are the
 * catalog's MCX rows whose underlying symbol is exactly the commodity (so CRUDEOIL never picks up
 * CRUDEOILM, GOLD never GOLDM), and the exchange / segment / trading symbol sent to Groww are those
 * rows' own values. If the catalog has no such rows, the caller gets a clear error, not a guess.
 */

export type Derivatives = {
  underlying: string;
  exchange: string;
  /** Segment of the option rows (FNO for index options; whatever Groww lists for MCX). */
  segment: string;
  options: GrowwInstrument[];
  futures: GrowwInstrument[];
};

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function derivativesIn(catalog: GrowwInstrumentCatalog, underlying: string): Derivatives {
  const def = UNDERLYINGS[underlying];
  if (!def) throw new Error(`Unsupported underlying ${underlying}.`);
  const all = catalog.getAll();
  if (!isCommodity(underlying)) {
    const exchange = def.exchange;
    const rows = all.filter((item) => item.segment === "FNO" && item.underlyingSymbol === underlying);
    return { underlying, exchange, segment: "FNO", options: rows.filter((item) => item.instrumentType === "CE" || item.instrumentType === "PE"), futures: rows.filter((item) => item.instrumentType === "FUT") };
  }
  const rows = all.filter((item) => item.exchange === def.exchange && item.underlyingSymbol === underlying && Boolean(item.expiryDate));
  const options = rows.filter((item) => item.instrumentType === "CE" || item.instrumentType === "PE");
  const futures = rows.filter((item) => item.instrumentType === "FUT");
  if (!options.length && !futures.length) throw new Error(`Groww's instrument list has no ${def.exchange} ${underlying} contracts (check that commodity trading is enabled on the Groww account).`);
  const segments = [...new Set(options.map((item) => item.segment))];
  if (segments.length > 1) throw new Error(`Groww lists ${underlying} options in more than one segment (${segments.join(", ")}); refusing to guess.`);
  return { underlying, exchange: def.exchange, segment: segments[0] ?? futures[0]?.segment ?? "", options, futures };
}

export async function derivativesFor(underlying: string) {
  return derivativesIn(await loadGrowwInstrumentCatalog(), underlying);
}

/** Nearest unexpired option expiry (ISO date). */
export function nearestOptionExpiry(d: Derivatives, today = istToday()) {
  return d.options.map((item) => String(item.expiryDate)).filter((value) => value >= today).sort()[0] ?? null;
}

/** Nearest unexpired future: a commodity's spot and tape. Expiring today rolls to the next one. */
export function nearestFuture(d: Derivatives, today = istToday()) {
  return d.futures.filter((item) => String(item.expiryDate) > today).sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))[0] ?? null;
}

/** Find one option/future contract of any supported underlying by its trading symbol. */
export function contractBySymbol(catalog: GrowwInstrumentCatalog, tradingSymbol: string) {
  for (const exchange of ["NSE", "BSE", "MCX"]) {
    const item = catalog.getByTradingSymbol(exchange, tradingSymbol);
    if (item && item.segment !== "CASH") return item;
  }
  return null;
}
