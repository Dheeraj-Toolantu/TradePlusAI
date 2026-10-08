import { NextResponse } from "next/server";
import { SmartScalper, type ScalperBar, type ScalperContract, type ScalperSettings } from "../../../../../services/paper-trading/src/smart-scalper";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";
import { getMarketIntel, isIntelSymbol, type MarketIntel } from "../../../lib/market-intel";

// Paper-only smart scalper behind the execution page's scalper desk. One process-wide book so
// scans and manual Buy/Sell/Exit act on the same positions. Fills include slippage.
const globalScalper = globalThis as typeof globalThis & { __tradepulseScalper?: SmartScalper };
const scalper = (globalScalper.__tradepulseScalper ??= new SmartScalper({ slippagePct: Number(process.env.SCALPER_SLIPPAGE_PCT ?? 0.3) / 100 }));

type RecordValue = Record<string, unknown>;
const numberOf = (value: unknown) => { const result = Number(value); return Number.isFinite(result) ? result : 0; };

function toContract(value: RecordValue): ScalperContract {
  return {
    symbol: String(value.symbol ?? ""), contract: String(value.contract ?? "").toUpperCase() === "PUT" ? "PUT" : "CALL", expiry: String(value.expiry ?? ""),
    strike: numberOf(value.strike), premium: numberOf(value.premium), bid: numberOf(value.bid), ask: numberOf(value.ask), openInterest: numberOf(value.openInterest),
    volume: numberOf(value.volume), iv: numberOf(value.iv), delta: numberOf(value.delta), theta: numberOf(value.theta), lotSize: numberOf(value.lotSize), tickSize: numberOf(value.tickSize),
  };
}

function toBar(value: RecordValue): ScalperBar {
  const time = numberOf(value.time) || Math.floor(Date.parse(String(value.timestamp ?? "")) / 1000);
  return { time, open: numberOf(value.open), high: numberOf(value.high), low: numberOf(value.low), close: numberOf(value.close), volume: numberOf(value.volume) };
}

export async function GET(request: Request) {
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  return NextResponse.json(await scalper.snapshot(symbol));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as RecordValue;
  const action = String(body.action ?? "scan");
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const contracts = (Array.isArray(body.contracts) ? body.contracts : []).map((item: RecordValue) => toContract(item)).filter((item) => item.symbol && item.strike > 0);
  try {
    if (action === "buy" || action === "sell") {
      const contract = body.contract && typeof body.contract === "object" ? toContract(body.contract as RecordValue) : null;
      if (!contract?.symbol || !(contract.premium > 0) || !(contract.lotSize > 0)) return NextResponse.json({ error: "A contract with a live premium and lot size is required." }, { status: 400 });
      if (action === "buy") {
        const safety = readSafeModeState();
        if (safety.killSwitch || safety.safeMode) return NextResponse.json({ error: `New entries blocked: ${safety.killSwitch ? safety.killSwitchReason : safety.safeModeReason}` }, { status: 423 });
      }
      const result = action === "buy" ? await scalper.buy(symbol, contract, numberOf(body.lots) || 1) : await scalper.sell(symbol, contract, numberOf(body.lots) || 1);
      return NextResponse.json(result, { status: "error" in result && result.error ? 409 : 200 });
    }
    if (action === "take") {
      const safety = readSafeModeState();
      const entryBlockedReason = safety.killSwitch ? `KILL_SWITCH_ACTIVE: ${safety.killSwitchReason}` : safety.safeMode ? `SAFE_MODE_ACTIVE: ${safety.safeModeReason}` : undefined;
      const result = await scalper.take(symbol, contracts, { entryBlockedReason, settings: (body.settings && typeof body.settings === "object" ? body.settings : {}) as Partial<ScalperSettings> });
      return NextResponse.json(result, { status: "error" in result && result.error ? 409 : 200 });
    }
    if (action === "exit" || action === "exitAll") {
      const ids = action === "exitAll" ? "ALL" as const : (Array.isArray(body.ids) ? body.ids.map(String) : []);
      return NextResponse.json(await scalper.exit(symbol, ids, contracts));
    }
    const spot = numberOf(body.spot);
    const bars = (Array.isArray(body.bars) ? body.bars : []).map((item: RecordValue) => toBar(item)).filter((bar) => bar.time > 0 && bar.close > 0);
    if (!(spot > 0) || !contracts.length) return NextResponse.json({ error: "Scan needs a live spot and the option chain." }, { status: 400 });
    const safety = readSafeModeState();
    const entryBlockedReason = safety.killSwitch ? `KILL_SWITCH_ACTIVE: ${safety.killSwitchReason}` : safety.safeMode ? `SAFE_MODE_ACTIVE: ${safety.safeModeReason}` : undefined;
    const autoEntries = Boolean(body.autoEntries);
    // Market intel (cached 20 s) adds 5m demand/supply zones and the VIX regime, in both trade modes.
    let intel: MarketIntel | null = null;
    if (isIntelSymbol(symbol)) intel = await getMarketIntel(symbol, { origin: new URL(request.url).origin }).catch(() => null);
    const zones = intel?.available ? intel.smart_entry?.zones ?? [] : [];
    const result = await scalper.scan({
      symbol, spot, bars, contracts, autoEntries, zones, entryBlockedReason,
      vixRegime: intel?.available ? intel.volatility?.regime ?? null : null,
      settings: (body.settings && typeof body.settings === "object" ? body.settings : {}) as Partial<ScalperSettings>,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scalper request failed" }, { status: 503 });
  }
}
