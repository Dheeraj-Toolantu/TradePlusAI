import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { readGrowwConfig } from "../../../../../services/execution/src/groww-config";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";
import { GrowwAdapter, createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../adapters/groww/src/groww-instruments";
import { exitLivePosition, moveTrailingStop, submitLiveEntry } from "../../../../../services/execution/src/live-order-service";
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
      paperOrders = remoteOrders;
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
  if (!config.accessTokenConfigured && !config.apiKeySecretConfigured) return paperOrders.map((order) => ({ ...order, currentPrice: order.currentPrice ?? order.price, pnl: order.pnl ?? 0, pnlPercent: order.pnlPercent ?? 0, quoteSource: order.currentPrice ? "Last known quote (Groww unavailable)" : "Entry price (Groww unavailable)" }));
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
      if (order.mode === "ALGO_LIVE" && order.brokerStopOrderId && order.trailingDistance && currentPrice > 0) {
        const favorable = order.side.toUpperCase() === "BUY" ? currentPrice > entry : currentPrice < entry;
        const activated = order.side.toUpperCase() === "BUY" ? currentPrice >= Number(order.target ?? Infinity) : currentPrice <= Number(order.target ?? -Infinity);
        const previousHighWater = Number(order.highWaterMark ?? entry);
        const highWaterMark = order.side.toUpperCase() === "BUY" ? Math.max(previousHighWater, currentPrice) : Math.min(previousHighWater, currentPrice);
        const candidateStop = order.side.toUpperCase() === "BUY" ? highWaterMark - order.trailingDistance : highWaterMark + order.trailingDistance;
        const previousStop = Number(order.trailingStop ?? order.stopLoss ?? 0);
        const improves = order.side.toUpperCase() === "BUY" ? candidateStop > previousStop : candidateStop < previousStop;
        if (favorable && activated && improves && candidateStop > 0) {
          try {
            const moved = await moveTrailingStop(new GrowwAdapter(createGrowwTransport()), { referenceId: `ts-${Date.now()}`, stopOrderId: order.brokerStopOrderId, symbol: order.symbol, quantity: order.quantity, entrySide: order.side.toUpperCase() === "BUY" ? "BUY" : "SELL", stopPrice: candidateStop, exchange: String(order.symbol).startsWith("SENSEX") ? "BSE" : "NSE", product: "NRML" });
            const trailingUpdates: Partial<OrderRecord> = { highWaterMark, trailingStop: candidateStop, trailingActivatedAt: order.trailingActivatedAt ?? new Date().toISOString(), brokerStopOrderId: moved.brokerOrderId, updatedAt: new Date().toISOString() };
            Object.assign(order, trailingUpdates);
            void updateOrderInFirestore(order.id, trailingUpdates);
          } catch { /* Keep the existing protective stop when a broker modification fails. */ }
        }
      }
      return { ...order, currentPrice, pnl, pnlPercent: entry ? (currentPrice - entry) / entry * 100 * direction : 0, quoteSource: "Groww real-time F&O quote" };
    } catch {
      return {
        ...order,
        currentPrice: order.currentPrice ?? order.price,
        pnl: order.pnl ?? 0,
        pnlPercent: order.pnlPercent ?? 0,
        quoteSource: order.currentPrice ? "Last known quote (Groww quote unavailable)" : "Entry price (quote unavailable)",
      };
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
  const [historyResponse, chainResponse] = await Promise.all([
    fetch(`${origin}/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=5m&period=week&date=${new Date().toISOString().slice(0, 10)}`, { cache: "no-store" }),
    fetch(`${origin}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }),
  ]);
  const [history, chain] = await Promise.all([historyResponse.json(), chainResponse.json()]);
  if (!historyResponse.ok) throw new Error(String(history.error ?? "Market history unavailable"));
  const root = existsSync(path.resolve(process.cwd(), "quant")) ? process.cwd() : path.resolve(process.cwd(), "../..");
  const executable = process.env.PYTHON_EXECUTABLE ?? "python";
  let optionEvidence: Record<string, unknown> = {};
  try {
    const contracts = Array.isArray(chain.contracts) ? chain.contracts as Array<Record<string, unknown>> : [];
    const calls = contracts.filter((contract) => contract.contract === "CALL");
    const puts = contracts.filter((contract) => contract.contract === "PUT");
    const sum = (items: Array<Record<string, unknown>>, key: string) => items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
    const callOi = sum(calls, "openInterest");
    const putOi = sum(puts, "openInterest");
    const callVolume = sum(calls, "volume");
    const putVolume = sum(puts, "volume");
    const avg = (items: Array<Record<string, unknown>>, key: string) => items.length ? sum(items, key) / items.length : null;
    const oiPcr = callOi > 0 ? putOi / callOi : null;
    const avgIv = avg(contracts, "iv");
    const avgScore = avg(contracts, "score");
    const avgTurnover = contracts.length ? contracts.reduce((total, contract) => total + Number(contract.volume ?? 0) / Math.max(Number(contract.openInterest ?? 0), 1), 0) / contracts.length : 0;
    const liquidityScore = contracts.length && avgScore !== null
      ? Math.max(0, Math.min(3, Math.round((Number(avgScore) / 100) * 3 + (avgTurnover >= 0.5 ? 1 : 0))))
      : null;
    const ivRegime = avgIv === null ? null : avgIv < 20 ? "LOW" : avgIv <= 35 ? "NORMAL" : "HIGH";
    optionEvidence = {
      ors: contracts.length ? (callVolume + putVolume) / Math.max(callOi + putOi, 1) : null,
      oi_direction_score: oiPcr === null ? null : oiPcr >= 0.8 && oiPcr <= 1.3 ? 1 : 0,
      iv_regime: ivRegime,
      liquidity_score: liquidityScore,
      ors_confirmed: contracts.length > 0,
      oi_pcr_supportive: oiPcr !== null && oiPcr >= 0.5 && oiPcr <= 1.8,
      option_quote_fresh: contracts.length > 0,
    };
  } catch { optionEvidence = {}; }
  const payload = { symbol, strategy, candles: history.candles ?? [], risk_per_trade: 1000, option_evidence: optionEvidence, pipeline: evidence };
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

  if (url.searchParams.get("ordersOnly") === "true") {
    return NextResponse.json({ orders: await markedPaperOrders(), updatedAt: new Date().toISOString() });
  }

  const safeModeState = readSafeModeState();

  try {
    const adapter = new GrowwAdapter(createGrowwTransport());
    const health = await adapter.healthCheck();
    const brokerHealthy = Boolean(health && "value" in health && health.value.connected && health.value.authenticated);
    const evidence = {
      broker_healthy: brokerHealthy,
      safe_mode: safeModeState.safeMode,
      kill_switch: safeModeState.killSwitch,
    };
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
    if (config.executionMode !== "ALGO_LIVE" || !config.liveExecutionEnabled || !config.complianceApproved || !config.liveTradingConfirmationRequired) {
      return NextResponse.json({ error: "LIVE_EXECUTION_DISABLED: all server-side live execution and confirmation gates must be enabled." }, { status: 403 });
    }
    if (body.confirmLive !== true) return NextResponse.json({ error: "LIVE_CONFIRMATION_REQUIRED: explicitly confirm this order in the UI." }, { status: 400 });
  }

  if (requestedMode !== config.executionMode || !["PAPER", "ALGO_LIVE"].includes(requestedMode)) {
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

  if (!String(body.symbol ?? "").trim() || !Number.isFinite(quantity) || quantity <= 0 || (!Number.isFinite(price) && requestedMode === "PAPER") || (Number.isFinite(price) && price <= 0) || !Number.isFinite(target) || target <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    return NextResponse.json({ error: "Orders require a symbol, positive quantity, target, and stop loss." }, { status: 400 });
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
    const serverAnalysis = await runEngine(underlying, provider, new URL(request.url).origin, strategy, {
      broker_healthy: brokerHealthy,
      safe_mode: safeModeState.safeMode,
      kill_switch: safeModeState.killSwitch,
    });
    const pipeline = serverAnalysis.pipeline as { decision?: string; reasons?: string[] } | undefined;
    if (pipeline?.decision !== "CONFIRMED") {
      return NextResponse.json({ error: "V5 no-trade gate rejected the paper entry.", reasons: pipeline?.reasons ?? ["SERVER_PIPELINE_UNAVAILABLE"] }, { status: 403 });
    }
  }

  const direction = side === "SELL" ? -1 : 1;
  if ((target - price) * direction <= 0 || (price - stopLoss) * direction <= 0) {
    return NextResponse.json({ error: "V5 structural risk invalid: target must be beyond entry and stop must be on the invalidation side." }, { status: 400 });
  }
  const liveEntryPrice = await fnoQuote(String(body.symbol));
  if (requestedMode === "ALGO_LIVE" && !liveEntryPrice && !Number.isFinite(price)) return NextResponse.json({ error: "LIVE_ENTRY_BLOCKED: Groww quote unavailable for live order." }, { status: 503 });
  const entryPrice = liveEntryPrice ?? price;
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(target - entryPrice);
  if (!risk || reward / risk < 2.0) {
    return NextResponse.json({ error: "Paper entry requires the V5 minimum expected reward of 2.0R." }, { status: 400 });
  }

  const symbol = String(body.symbol);

  if (requestedMode === "ALGO_LIVE") {
    const referenceId = `live-${Date.now()}`;
    const stopReferenceId = `sl-${Date.now()}`;
    try {
      const live = await submitLiveEntry(adapter, { referenceId, stopReferenceId, symbol, quantity, side: side as "BUY" | "SELL", entryPrice: String(body.orderType ?? "MARKET").toUpperCase() === "LIMIT" && Number.isFinite(price) ? price : undefined, stopLoss, exchange: underlying.toUpperCase() === "SENSEX" ? "BSE" : "NSE", product: "NRML" });
      const trailingDistance = Number(body.trailingDistance);
      const entryPrice = live.entry.averageFillPrice ?? liveEntryPrice ?? price;
      const order: OrderRecord = { id: referenceId, strategy, strategyName: String(body.strategyName ?? strategy), symbol, growwSymbol: String(body.growwSymbol ?? symbol), expiry, side, quantity, lotSize: lotSize || undefined, price: entryPrice, target, stopLoss, status: live.entry.status === "FILLED" ? "FILLED" : "OPEN", mode: "ALGO_LIVE", source: "Groww live F&O order", createdAt: new Date().toISOString(), brokerOrderId: live.entry.brokerOrderId, brokerStopOrderId: live.protectiveStop.brokerOrderId, trailingDistance: Number.isFinite(trailingDistance) && trailingDistance > 0 ? trailingDistance : risk, highWaterMark: entryPrice };
      await saveOrderToFirestore(order);
      return NextResponse.json({ order, mode: "ALGO_LIVE", liveOrders: 1, firestoreSynced: true });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Groww live order failed" }, { status: 502 });
    }
  }

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

  const index = paperOrders.findIndex((order) => order.id === id);
  if (index < 0) return NextResponse.json({ error: "Paper order was not found." }, { status: 404 });

  const [order] = paperOrders.splice(index, 1);
  if (order.mode === "ALGO_LIVE") {
    const config = readGrowwConfig();
    if (config.executionMode !== "ALGO_LIVE" || !config.liveExecutionEnabled || !config.complianceApproved || !config.liveTradingConfirmationRequired) return NextResponse.json({ error: "LIVE_EXIT_DISABLED: live execution gates are not enabled." }, { status: 403 });
    try {
      const exit = await exitLivePosition(new GrowwAdapter(createGrowwTransport()), { referenceId: `exit-${Date.now()}`, symbol: order.symbol, quantity: order.quantity, entrySide: order.side.toUpperCase() === "BUY" ? "BUY" : "SELL", exchange: String(order.symbol).startsWith("SENSEX") ? "BSE" : "NSE", product: "NRML", protectiveStopOrderId: order.brokerStopOrderId });
      const updates: Partial<OrderRecord> = { status: "EXITED", exitAt: new Date().toISOString(), exitReason: "MANUAL_EXIT", brokerExitOrderId: exit.brokerOrderId, exitPrice: exit.averageFillPrice };
      await updateOrderInFirestore(order.id, updates);
      return NextResponse.json({ order: { ...order, ...updates }, status: "EXITED", mode: "ALGO_LIVE", firestoreUpdated: true });
    } catch (error) {
      paperOrders.unshift(order);
      return NextResponse.json({ error: error instanceof Error ? error.message : "Groww live exit failed" }, { status: 502 });
    }
  }
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

