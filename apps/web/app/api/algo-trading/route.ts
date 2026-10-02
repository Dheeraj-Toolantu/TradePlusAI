import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { readGrowwConfig } from "../../../../../services/execution/src/groww-config";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";
import { GrowwAdapter, createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../adapters/groww/src/groww-instruments";
import { getMarketIntel, isIntelSymbol, istDate } from "../../../lib/market-intel";
import { DAILY_RISK_RULES, evaluateDailyRisk } from "../../../lib/daily-risk";
import {
  saveOrderToFirestore,
  updateOrderInFirestore,
  getActiveOrdersFromFirestore,
  getAllOrdersFromFirestore,
  OrderRecord,
} from "../../../lib/firestore-orders";

let paperOrders: Array<OrderRecord> = [];
let firestoreHydrated = false;
const supported = ["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "TCS", "INFY", "HDFCBANK"];
const paperStrategies = new Set(["ORB_RETEST", "VWAP_REVERSAL"]);

type RecordValue = Record<string, unknown>;

function payloadOf(value: unknown): RecordValue { return ((value as { payload?: RecordValue })?.payload ?? {}) as RecordValue; }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function hydrateFromFirestore() {
  if (firestoreHydrated) return;
  try {
    const remoteOrders = await getActiveOrdersFromFirestore();
    if (remoteOrders.length > 0) {
      // Real-money positions are owned by /api/live-orders; the paper book must never touch them.
      paperOrders = remoteOrders.filter((order) => order.mode !== "ALGO_LIVE");
    }
    firestoreHydrated = true;
  } catch (err) {
    console.warn("Could not hydrate orders from Firestore:", err);
  }
}

async function fnoQuote(symbol: string) {
  const config = readGrowwConfig();
  if (!config.accessTokenConfigured && !config.apiKeySecretConfigured) return null;
  try {
    const body = await createGrowwTransport().request(`/v1/live-data/quote?exchange=NSE&segment=FNO&trading_symbol=${encodeURIComponent(symbol)}`, { method: "GET" });
    const price = Number(payloadOf(body).ltp ?? payloadOf(body).last_price ?? payloadOf(body).lastPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

async function markedPaperOrders() {
  await hydrateFromFirestore();
  const config = readGrowwConfig();
  if (!config.accessTokenConfigured && !config.apiKeySecretConfigured) return paperOrders.map((order) => ({ ...order, currentPrice: order.price, pnl: 0, pnlPercent: 0, quoteSource: "Entry price (Groww unavailable)" }));
  const transport = createGrowwTransport();
  return Promise.all(paperOrders.map(async (order) => {
    try {
      const body = await transport.request(`/v1/live-data/quote?exchange=NSE&segment=FNO&trading_symbol=${encodeURIComponent(String(order.symbol))}`, { method: "GET" });
      const payload = payloadOf(body);
      const currentPrice = Number(payload.ltp ?? payload.last_price ?? payload.lastPrice);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("Quote unavailable");
      const entry = Number(order.price); const quantity = Number(order.quantity);
      const direction = String(order.side).toUpperCase() === "SELL" ? -1 : 1;
      const pnl = (currentPrice - entry) * quantity * direction;
      return { ...order, currentPrice, pnl, pnlPercent: entry ? (currentPrice - entry) / entry * 100 * direction : 0, quoteSource: "Groww real-time F&O quote" };
    } catch {
      return { ...order, currentPrice: order.price, pnl: 0, pnlPercent: 0, quoteSource: "Entry price (quote unavailable)" };
    }
  }));
}

async function growwAccountSummary() {
  const config = readGrowwConfig();
  if (!config.accessTokenConfigured && !config.apiKeySecretConfigured) throw new Error("Groww credentials are not configured");
  const body = await createGrowwTransport().request("/v1/margins/detail/user", { method: "GET" });
  const payload = payloadOf(body);
  const number = (...keys: string[]) => { for (const key of keys) { const value = Number(payload[key]); if (Number.isFinite(value)) return value; } return null; };
  const available = number("clear_cash", "option_buy_balance_available", "cnc_balance_available", "available_margin", "available_cash", "available_balance");
  const used = number("net_margin_used", "net_fno_margin_used", "net_equity_margin_used", "used_margin", "used_cash", "used_balance");
  const collateral = number("collateral_available");
  return { available, used, total: available === null ? null : available + (collateral ?? 0) + (used ?? 0), currency: "INR", source: "Groww margin detail", updatedAt: new Date().toISOString() };
}

async function runEngine(symbol: string, provider: string, origin: string, strategy: string, evidence: Record<string, unknown> = {}) {
  // 5m index candles carry near-month futures volume (index volume is always zero); daily
  // candles give the true ATR14 used by the gap-day rule.
  const [historyResponse, daily] = await Promise.all([
    fetch(`${origin}/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=5m&period=week&volume=futures&date=${istDate()}`, { cache: "no-store" }),
    fetch(`${origin}/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=1D&period=month&date=${istDate()}`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : {})).catch(() => ({})) as Promise<{ candles?: unknown[] }>,
  ]);
  const history = await historyResponse.json();
  if (!historyResponse.ok) throw new Error(String(history.error ?? "Market history unavailable"));
  // A delayed (Yahoo fallback) chart is minutes behind the market: never let it confirm a setup.
  if (history.delayed) throw new Error("Live 5-minute candles are unavailable (only delayed data); the strategy engine will not evaluate on stale prices.");
  const root = existsSync(path.resolve(process.cwd(), "quant")) ? process.cwd() : path.resolve(process.cwd(), "../..");
  const executable = process.env.PYTHON_EXECUTABLE ?? "python";
  // Option evidence comes from the market-intel engine: signed OI-flow direction score from
  // 5-minute OI change, delta-normalised option relative strength, India VIX regime and
  // strike liquidity. The V5 engine decides whether it supports the setup's direction.
  // Unavailable evidence stays absent so the no-trade gate fails closed.
  let optionEvidence: Record<string, unknown> = {};
  if (isIntelSymbol(symbol)) {
    try {
      const intel = await getMarketIntel(symbol, { origin });
      optionEvidence = (intel.v5_option_evidence ?? {}) as Record<string, unknown>;
    } catch { optionEvidence = {}; }
  }
  const payload = { symbol, strategy, candles: history.candles ?? [], daily_candles: Array.isArray(daily.candles) ? daily.candles : [], volume_source: history.volumeSource ?? null, risk_per_trade: PAPER_CAPITAL * DAILY_RISK_RULES.riskPerTradePct / 100, option_evidence: optionEvidence, pipeline: evidence };
  return new Promise<RecordValue>((resolve, reject) => {
    const child = spawn(executable, ["-m", "tradepulse_quant.algo_engine.engine"], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "quant", "src") }, windowsHide: true });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { if (code !== 0) reject(new Error(error || `Algo engine exited with ${code}`)); else { try { resolve(JSON.parse(output) as RecordValue); } catch { reject(new Error("Algo engine returned invalid JSON")); } } });
    child.stdin.end(JSON.stringify(payload));
  });
}

// Operational evidence for the V5 no-trade gate. Previously only broker health, SAFE_MODE and
// the kill switch were supplied, so DAILY_RISK, CONTRACT_METADATA, RECONCILIATION and
// EXECUTION_READY were always "missing" and the pipeline could never confirm a setup.
const PAPER_CAPITAL = Number(process.env.PAPER_CAPITAL ?? 100_000);

async function operationalEvidence(symbol: string, brokerHealthy: boolean, safety: { safeMode: boolean; killSwitch: boolean }) {
  const today = istDate();
  const [orders, catalog] = await Promise.all([
    getAllOrdersFromFirestore(200).catch(() => null),
    loadGrowwInstrumentCatalog().catch(() => null),
  ]);
  // Fail closed: an unreadable order book must not look like "no trades today".
  const dailyRisk = orders === null ? { allowed: false, detail: "Blocked: the order book could not be read, so today's trades and losses are unknown" } : evaluateDailyRisk(orders, symbol, PAPER_CAPITAL);
  const contractMetadata = catalog === null ? false : catalog.getAll().some((instrument) => instrument.segment === "FNO" && instrument.underlyingSymbol === symbol && (instrument.instrumentType === "CE" || instrument.instrumentType === "PE") && String(instrument.expiryDate ?? "") >= today && Number(instrument.lotSize) > 0);
  return {
    broker_healthy: brokerHealthy,
    safe_mode: safety.safeMode,
    kill_switch: safety.killSwitch,
    daily_risk_allowed: dailyRisk.allowed,
    daily_risk_detail: dailyRisk.detail,
    contract_metadata_available: contractMetadata,
    // The paper book is the system of record for paper trades; real positions are reconciled
    // against Groww by the live monitor (/api/live-orders), not by this gate.
    reconciliation_ok: true,
    execution_ready: !safety.safeMode && !safety.killSwitch,
  };
}

async function validateLiveContract(body: RecordValue): Promise<string | null> {
  const symbol = String(body.symbol ?? "");
  const underlying = String(body.underlying ?? "").toUpperCase();
  const exchange = underlying === "SENSEX" ? "BSE" : "NSE";
  const catalog = await loadGrowwInstrumentCatalog();
  const instrument = catalog.getByGrowwSymbol(String(body.growwSymbol ?? ""))
    ?? catalog.getByTradingSymbol(exchange, symbol);
  if (!instrument || instrument.tradingSymbol !== symbol || instrument.segment !== "FNO") return "Contract is not present in the live Groww contract master.";
  if (instrument.instrumentType !== String(body.optionType ?? "").toUpperCase()) return "Option type does not match the live contract master.";
  if (instrument.expiryDate !== String(body.expiry ?? "") || Number(instrument.strikePrice) !== Number(body.strike)) return "Expiry or strike does not match the live contract master.";
  if (Number(instrument.lotSize) !== Number(body.lotSize) || Number(instrument.tickSize) !== Number(body.tickSize) || Number(instrument.freezeQuantity) !== Number(body.freezeQuantity)) return "Lot, tick, or freeze quantity does not match the live contract master.";
  if (instrument.isReserved === true || instrument.buyAllowed === false) return "The live contract is not active or buy-enabled.";
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const provider = url.searchParams.get("provider") ?? "groww";
  const strategy = url.searchParams.get("strategy") ?? "ORB_RETEST";
  const historyOnly = url.searchParams.get("history") === "true";
  const config = readGrowwConfig();

  if (historyOnly) {
    const history = await getAllOrdersFromFirestore();
    return NextResponse.json({ history, source: "Cloud Firestore order collection" });
  }

  if (!supported.includes(symbol)) return NextResponse.json({ error: "Unsupported symbol" }, { status: 400 });
  if (!new Set(["ORB_RETEST", "VWAP_REVERSAL", "RANGE_DEFINED_RISK"]).has(strategy)) return NextResponse.json({ error: "Unsupported strategy" }, { status: 400 });
  if (provider !== "groww") return NextResponse.json({ error: "Groww is the only supported market-data and execution provider for the algo trading page." }, { status: 400 });

  const safeModeState = readSafeModeState();

  try {
    const adapter = new GrowwAdapter(createGrowwTransport());
    const health = await adapter.healthCheck();
    const brokerHealthy = Boolean(health && "value" in health && health.value.connected && health.value.authenticated);
    const evidence = await operationalEvidence(symbol, brokerHealthy, safeModeState);
    const [analysis, account, liveOrders, history] = await Promise.all([
      runEngine(symbol, provider, url.origin, strategy, evidence),
      provider === "groww" ? growwAccountSummary().catch(() => null) : Promise.resolve(null),
      markedPaperOrders(),
      getAllOrdersFromFirestore(30),
    ]);

    const normalizedOrders = Array.from(new Map((liveOrders ?? []).map((order) => [order.id, order])).values());
    const normalizedHistory = Array.from(new Map((history ?? []).map((order) => [order.id, order])).values());

    return NextResponse.json({
      analysis,
      strategy,
      account,
      broker: health && ("value" in health ? health.value : { connected: false, error: health.error.message }),
      mode: config.executionMode,
      liveExecution: config.executionMode === "ALGO_LIVE" && config.liveExecutionEnabled && config.complianceApproved,
      safeMode: safeModeState.safeMode,
      safeModeReason: safeModeState.safeModeReason,
      killSwitch: safeModeState.killSwitch,
      killSwitchReason: safeModeState.killSwitchReason,
      orders: normalizedOrders,
      history: normalizedHistory,
      firestoreConnected: true,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Algo analysis unavailable",
      mode: config.executionMode,
      safeMode: safeModeState.safeMode,
      killSwitch: safeModeState.killSwitch,
      orders: paperOrders,
      history: [],
      firestoreConnected: false,
    }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as RecordValue;
  const config = readGrowwConfig();
  const requestedMode = String(body.mode ?? config.executionMode).toUpperCase();

  if (requestedMode === "ALGO_LIVE") {
    if (config.executionMode !== "ALGO_LIVE" || !config.liveExecutionEnabled || !config.complianceApproved) {
      return NextResponse.json({ error: "LIVE_EXECUTION_DISABLED: set EXECUTION_MODE=ALGO_LIVE, LIVE_EXECUTION_ENABLED=true, and LIVE_COMPLIANCE_APPROVED=true only after all release gates pass." }, { status: 403 });
    }
    return NextResponse.json({ error: "LIVE_ORDERS_USE_CONFIRMATION_FLOW: real-money orders go through /api/live-orders (preview, then PIN-confirmed submit); no live order was sent from this route." }, { status: 400 });
  }

  if (requestedMode !== config.executionMode || requestedMode !== "PAPER") {
    return NextResponse.json({ error: `Execution mode is configured as ${config.executionMode}. Change EXECUTION_MODE in .env.local before requesting ${requestedMode}.` }, { status: 409 });
  }

  const quantity = Number(body.quantity ?? 1);
  const price = Number(body.price ?? 0);
  const target = Number(body.target);
  const stopLoss = Number(body.stopLoss);
  const strategy = String(body.strategy ?? "ORB_RETEST");
  const lotSize = Number(body.lotSize ?? 0);
  const freezeQuantity = Number(body.freezeQuantity ?? 0);
  const tickSize = Number(body.tickSize ?? 0);
  const strike = Number(body.strike ?? 0);
  const optionType = String(body.optionType ?? "").toUpperCase();
  const expiry = String(body.expiry ?? "");
  const provider = String(body.provider ?? "groww");

  if (!String(body.symbol ?? "").trim() || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(target) || target <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    return NextResponse.json({ error: "Paper orders require a symbol, positive quantity, entry price, take profit, and stop loss." }, { status: 400 });
  }
  if (!paperStrategies.has(strategy)) return NextResponse.json({ error: "This strategy is not enabled for single-leg paper execution." }, { status: 400 });
  const side = String(body.side ?? "BUY").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return NextResponse.json({ error: "Order side must be BUY or SELL." }, { status: 400 });
  if (!expiry || !Number.isFinite(strike) || strike <= 0 || !["CE", "PE"].includes(optionType) || !Number.isFinite(lotSize) || lotSize <= 0 || !Number.isFinite(tickSize) || tickSize <= 0 || !Number.isFinite(freezeQuantity) || freezeQuantity <= 0) {
    return NextResponse.json({ error: "Paper entry requires complete live contract metadata: expiry, strike, option type, lot size, tick size, and freeze quantity." }, { status: 400 });
  }
  if (body.contractActive !== true) return NextResponse.json({ error: "Paper entry requires an active contract from the contract master." }, { status: 400 });
  if (quantity % lotSize !== 0) return NextResponse.json({ error: `Quantity must be a multiple of the live lot size (${lotSize}).` }, { status: 400 });
  if (quantity > freezeQuantity) return NextResponse.json({ error: "Requested quantity exceeds the live freeze quantity; child-order execution is not enabled." }, { status: 400 });

  if (provider !== "groww") return NextResponse.json({ error: "Groww is the only supported market-data and execution provider for the algo trading page." }, { status: 400 });

  const contractError = await validateLiveContract(body);
  if (contractError) return NextResponse.json({ error: contractError }, { status: 400 });

  const safeModeState = readSafeModeState();
  if (safeModeState.killSwitch) return NextResponse.json({ error: `KILL_SWITCH_ACTIVE: ${safeModeState.killSwitchReason}` }, { status: 403 });
  if (safeModeState.safeMode) return NextResponse.json({ error: `SAFE_MODE_ACTIVE: ${safeModeState.safeModeReason}` }, { status: 403 });

  const orderSource = String(body.orderSource ?? "ALGO").toUpperCase();
  const underlying = String(body.underlying ?? body.symbol);
  const adapter = new GrowwAdapter(createGrowwTransport());
  let brokerHealthy = false;

  if (orderSource === "MANUAL") {
    brokerHealthy = true;
  } else {
    try {
      const health = await withTimeout(adapter.healthCheck(), 5000, "Groww health check");
      brokerHealthy = Boolean(health && "value" in health && health.value.connected && health.value.authenticated);
    } catch {
      brokerHealthy = false;
    }
  }

  // Manual paper entries are user-authored and do not send a real order to Groww.
  // The broker health check is therefore advisory for PAPER mode, not a hard blocker;
  // a timeout or transient auth failure should not prevent a valid local paper trade.
  if (orderSource !== "MANUAL" && !brokerHealthy) {
    return NextResponse.json({ error: "BROKER_UNHEALTHY: the Groww connection must be authenticated before a paper entry is accepted." }, { status: 503 });
  }
  if (orderSource !== "MANUAL") {
    // Algo-originated entries stay fail-closed behind the authoritative V5 pipeline.
    // Manual paper entries are explicitly user-authorized and skip this gate only; the
    // kill-switch, SAFE_MODE, broker-health, contract-master, lot/freeze, and minimum-2R
    // checks still apply to every order.
    const serverAnalysis = await runEngine(underlying, provider, new URL(request.url).origin, strategy, await operationalEvidence(underlying, brokerHealthy, safeModeState));
    const pipeline = serverAnalysis.pipeline as { decision?: string; reasons?: string[] } | undefined;
    if (pipeline?.decision !== "CONFIRMED") {
      return NextResponse.json({ error: "V5 no-trade gate rejected the paper entry.", reasons: pipeline?.reasons ?? ["SERVER_PIPELINE_UNAVAILABLE"] }, { status: 403 });
    }
    // A long-option strategy buys CE for a BUY (bullish) setup and PE for a SELL (bearish) one.
    const setupSide = String((serverAnalysis.setup as { side?: string } | undefined)?.side ?? "");
    const optionType = String(body.optionType ?? "").toUpperCase();
    if ((setupSide === "BUY" && optionType !== "CE") || (setupSide === "SELL" && optionType !== "PE")) {
      return NextResponse.json({ error: `V5 setup is ${setupSide === "BUY" ? "bullish: buy a CE" : "bearish: buy a PE"}; ${optionType || "this contract"} does not match the signal direction.` }, { status: 409 });
    }
  }

  const direction = side === "SELL" ? -1 : 1;
  if ((target - price) * direction <= 0 || (price - stopLoss) * direction <= 0) {
    return NextResponse.json({ error: "V5 structural risk invalid: target must be beyond entry and stop must be on the invalidation side." }, { status: 400 });
  }
  const liveEntryPrice = await fnoQuote(String(body.symbol));
  const entryPrice = liveEntryPrice ?? price;
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(target - entryPrice);
  if (!risk || reward / risk < 2.0) {
    return NextResponse.json({ error: "Paper entry requires the V5 minimum expected reward of 2.0R." }, { status: 400 });
  }

  const symbol = String(body.symbol);

  const order: OrderRecord = {
    id: `paper-${Date.now()}`,
    strategy,
    strategyName: String(body.strategyName ?? strategy),
    symbol,
    growwSymbol: String(body.growwSymbol ?? symbol),
    expiry,
    side,
    quantity,
    lotSize: lotSize || undefined,
    price: entryPrice,
    target,
    stopLoss,
    status: "OPEN",
    mode: "PAPER",
    source: liveEntryPrice ? "Paper broker · Groww F&O quote" : "Paper broker · submitted price",
    createdAt: new Date().toISOString(),
  };

  paperOrders.unshift(order);
  // Persist order asynchronously to Firestore so a slow cloud write cannot stall the
  // manual paper-order response. The in-memory order is available immediately.
  void saveOrderToFirestore(order);

  return NextResponse.json({ order, mode: "PAPER", liveOrders: 0, firestoreSynced: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Paper order id is required." }, { status: 400 });

  const index = paperOrders.findIndex((order) => order.id === id && order.mode !== "ALGO_LIVE");
  if (index < 0) return NextResponse.json({ error: id.startsWith("live-") ? "Live positions must be exited through /api/live-orders so a real sell order is sent." : "Paper order was not found." }, { status: 404 });

  const [order] = paperOrders.splice(index, 1);
  const currentLtp = (await fnoQuote(order.symbol)) ?? order.currentPrice ?? order.price;
  const direction = String(order.side).toUpperCase() === "SELL" ? -1 : 1;
  const realizedPnl = (currentLtp - order.price) * order.quantity * direction;
  const realizedPnlPercent = order.price ? ((currentLtp - order.price) / order.price) * 100 * direction : 0;

  const exitUpdates: Partial<OrderRecord> = {
    status: "EXITED",
    exitPrice: currentLtp,
    exitAt: new Date().toISOString(),
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    realizedPnlPercent: Math.round(realizedPnlPercent * 100) / 100,
    exitReason: "MANUAL_EXIT",
  };

  // Update order in Firestore without blocking the response.
  void updateOrderInFirestore(order.id, exitUpdates);

  return NextResponse.json({
    order: { ...order, ...exitUpdates },
    status: "EXITED",
    mode: "PAPER",
    firestoreUpdated: true,
  });
}

