"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketIntelPanel, type TradePlan } from "../../components/market-intel/market-intel-panel";
import { formatConfidenceText, formatExpectedMoveText, formatMarketCalculationValue, getOrderExitState } from "../../lib/option-chain-state";

type Option = { symbol: string; growwSymbol: string; type?: string; expiry?: string; strike?: number; lotSize?: number; tickSize?: number; freezeQuantity?: number; active?: boolean };
type PipelineGate = { code: string; passed: boolean; detail: string };
type Pipeline = { decision: string; reasons: string[]; gates: PipelineGate[] };
type Analysis = { decision: string; reason?: string; setup?: { side: string; entry: number; stop_loss: number; target: number; target_method?: string; stop_method?: string }; indicators?: { vwap: number }; levels?: { support: number; resistance: number }; calculations?: { underlying?: Record<string, number | null>; orb?: Record<string, number | string | null>; gap?: Record<string, number | string | null>; score?: Record<string, number | null>; risk?: Record<string, number | string | null>; option?: Record<string, number | string | null> }; session?: { time_ist: string; trading_day: boolean; window: string; market_open: boolean; entry_permitted: boolean }; pipeline?: Pipeline };
type Order = {
  id: string;
  symbol: string;
  growwSymbol?: string;
  strategy?: string;
  strategyName?: string;
  side: string;
  quantity: number;
  lotSize?: number;
  price: number;
  status: string;
  mode?: string;
  target?: number;
  stopLoss?: number;
  highWaterMark?: number;
  trailingStop?: number;
  trailingDistance?: number;
  trailingActivatedAt?: string;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  quoteSource?: string;
  createdAt: string;
  updatedAt?: string;
  exitPrice?: number;
  exitAt?: string;
  exitReason?: string;
  realizedPnl?: number;
  realizedPnlPercent?: number;
};
type QuoteUpdate = { symbol: string; price: number | null; timestamp: string; source: string };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type OptionCandidate = {
  symbol: string; contract: "CALL" | "PUT"; expiry: string; strike: number; premium: number; bid: number; ask: number; openInterest: number; volume: number; iv: number; delta: number; score: number; riskReward: number; lotSize?: number; tickSize?: number; freezeQuantity?: number; active?: boolean; reason: string;
  direction?: string; directional_score?: number; trend_score?: number; delta_score?: number; iv_score?: number; oi_score?: number; liquidity_score?: number; risk_reward_score?: number; final_score?: number; confidence?: number; decision?: string; feasibility?: { expected_move_points?: number; required_move?: number; breakeven?: number; expected_range?: { lower?: number; upper?: number }; breakeven_feasibility?: string; target_feasibility?: string }; pipeline?: { score_breakdown?: Record<string, number>; warnings?: string[] }; warnings?: string[]; target?: number; stop?: number;
};
type StrategyId = "ORB_RETEST" | "VWAP_REVERSAL" | "RANGE_DEFINED_RISK";
type StrategyDefinition = { id: StrategyId; name: string; shortName: string; description: string; minimumScore: number; minimumRiskReward: number; directional: boolean };
type OrderTab = "OPEN" | "POSITIONS" | "HISTORY" | "LOGS";
type AlgoLog = { time: string; text: string; type: "entry" | "exit" | "sync" | "info" };
const money = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const calculationValue = (value: number | string | null | undefined, percent = false) => formatMarketCalculationValue(value, { percent });
const normalizeSymbolKey = (value: string | undefined | null) => String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const isLiveQuoteSource = (source: string | undefined | null) => {
  const candidate = String(source ?? "").trim();
  if (!candidate) return true;
  const lowered = candidate.toLowerCase();
  if (lowered.includes("unavailable") || lowered.includes("entry price") || lowered.includes("not available") || lowered.includes("failed")) return false;
  return lowered.includes("groww") && (lowered.includes("quote") || lowered.includes("live") || lowered.includes("real") || lowered.includes("ltp"));
};
const hasLiveQuote = (order: Pick<Order, "currentPrice" | "price" | "pnl" | "pnlPercent" | "quoteSource">) => {
  const currentPrice = Number(order.currentPrice ?? order.price ?? NaN);
  const pnl = Number(order.pnl ?? NaN);
  const pnlPercent = Number(order.pnlPercent ?? NaN);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (!Number.isFinite(pnl) && !Number.isFinite(pnlPercent)) return false;
  return isLiveQuoteSource(order.quoteSource);
};
// Live ticks only move the last price. VWAP, EMAs, score and option evidence stay exactly as
// the backend V5 engine computed them: recomputing them client-side from a rolling window
// (the previous behaviour) silently replaced the session VWAP and the spec score.
const liveAnalysis = (current: Analysis | null, candles: Candle[]): Analysis | null => {
  if (!current || !candles.length) return current;
  return { ...current, calculations: { ...current.calculations, underlying: { ...(current.calculations?.underlying ?? {}), last_price: candles.at(-1)!.close } } };
};
// Fallback lot sizes (NSE/BSE revision effective Jan 2026) used only if the live contract
// master is unavailable; the Groww instrument metadata always wins.
const FALLBACK_LOT: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 };
const fallbackLot = (underlying: string) => FALLBACK_LOT[underlying] ?? 1;
const istDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const strategies: StrategyDefinition[] = [
  { id: "ORB_RETEST", name: "ORB + Retest", shortName: "Primary", description: "15m opening range breakout, 5m retest hold, VWAP and OI confirmation.", minimumScore: 8, minimumRiskReward: 2, directional: true },
  { id: "VWAP_REVERSAL", name: "VWAP Reversal", shortName: "Secondary", description: "Support or resistance rejection followed by a confirmed VWAP reclaim.", minimumScore: 8, minimumRiskReward: 2, directional: true },
  { id: "RANGE_DEFINED_RISK", name: "Range Defined Risk", shortName: "Range", description: "Defined-risk range setup for intact, non-trending sessions. No naked option selling.", minimumScore: 8, minimumRiskReward: 2, directional: false },
];

export default function ExecutionPage() {
  const [symbol, setSymbol] = useState("NIFTY");
  const provider = "groww";
  const [strategyId, setStrategyId] = useState<StrategyId>("ORB_RETEST");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState("NIFTY");
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState<Option | null>(null);
  const [quantity, setQuantity] = useState(FALLBACK_LOT.NIFTY);
  const [busy, setBusy] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [triggerMode, setTriggerMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [streamStatus, setStreamStatus] = useState("Connecting to live quotes...");
  const [message, setMessage] = useState("Paper mode is active. No live orders are sent.");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [marketCandles, setMarketCandles] = useState<Candle[]>([]);
  const [optionCandidates, setOptionCandidates] = useState<OptionCandidate[]>([]);
  const [marketQuotes, setMarketQuotes] = useState<Record<string, number>>({});
  const [account, setAccount] = useState<{ available: number | null; used: number | null; total: number | null; source: string } | null>(null);
  const [chainStatus, setChainStatus] = useState("Loading market data...");
  const [executionMode, setExecutionMode] = useState("PAPER");
  const [liveExecution, setLiveExecution] = useState(false);
  const [safeMode, setSafeMode] = useState<{ active: boolean; reason: string | null }>({ active: false, reason: null });
  const [killSwitch, setKillSwitch] = useState<{ active: boolean; reason: string | null }>({ active: false, reason: null });
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [autoMaxTrades, setAutoMaxTrades] = useState(3);
  const [autoMinimumLoss, setAutoMinimumLoss] = useState(2500);
  const [autoMinimumProfit, setAutoMinimumProfit] = useState(1000);
  const [autoTradeStatus, setAutoTradeStatus] = useState<{ tradesTaken: number; limitHit: boolean; summary: string; diagnostics?: string[]; suggestions: Array<{ symbol: string; contract: string; entry: number; stopLoss: number; target: number; score: number }> }>({ tradesTaken: 0, limitHit: false, summary: "Auto engine is disabled", suggestions: [] });
  const autoScanBusy = useRef(false);
  const autoScanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marketCandlesRef = useRef<Candle[]>([]);
  const optionCandidatesRef = useRef<OptionCandidate[]>([]);
  const [istClock, setIstClock] = useState("");
  const selectedStrategy = useMemo(
    () => strategies.find((strategy) => strategy.id === strategyId) ?? strategies[0],
    [strategyId],
  );

  const [orderTab, setOrderTab] = useState<OrderTab>("OPEN");
  const [orderHistory, setOrderHistory] = useState<Order[]>([]);
  const [firestoreSynced, setFirestoreSynced] = useState(true);
  const orderMutationVersion = useRef(0);
  const [algoLogs, setAlgoLogs] = useState<AlgoLog[]>([
    { time: new Date().toLocaleTimeString("en-IN"), text: "System initialized. Connected to Cloud Firestore 'orders' collection.", type: "sync" },
  ]);

  const refresh = useCallback(async () => {
    setBusy(true);
    const refreshMutationVersion = orderMutationVersion.current;
    try {
      const data = await fetch(`/api/algo-trading?symbol=${symbol}&provider=${provider}&strategy=${strategyId}`, { cache: "no-store" }).then((response) => response.json());
      setAnalysis(data.analysis ?? null);
      setAccount(data.account ?? null);
      if (refreshMutationVersion === orderMutationVersion.current) {
        setOrders(data.orders ?? []);
        setOrderHistory(data.history ?? []);
      }
      setFirestoreSynced(Boolean(data.firestoreConnected));
      setExecutionMode(String(data.mode ?? "PAPER"));
      setLiveExecution(Boolean(data.liveExecution));
      setSafeMode({ active: Boolean(data.safeMode), reason: data.safeModeReason ?? null });
      setKillSwitch({ active: Boolean(data.killSwitch), reason: data.killSwitchReason ?? null });
      if (data.broker?.connected === true) setStreamStatus("Groww REST market data connected");
      else setStreamStatus("Groww market data unavailable");
      if (data.orders?.length && !selectedOrderId) setSelectedOrderId(data.orders[0].id);
      if (data.analysis?.setup) { setTakeProfit(String(data.analysis.setup.target)); setStopLoss(String(data.analysis.setup.stop_loss)); }
      setMessage(data.error ?? "Deterministic engine updated");
    } catch { setMessage("Algo engine unavailable"); }
    finally { setBusy(false); }
  }, [provider, selectedOrderId, strategyId, symbol]);

  const runAutoOptionScan = useCallback(async (candleSnapshot = marketCandlesRef.current, candidateSnapshot = optionCandidatesRef.current) => {
    if (autoScanBusy.current || !autoTradeEnabled || !candleSnapshot.length || !candidateSnapshot.length) return;
    if (analysis?.session && (!analysis.session.market_open || !analysis.session.entry_permitted)) {
      setAutoTradeStatus((current) => ({ ...current, summary: "Auto scan waiting for the permitted market entry window" }));
      return;
    }
    autoScanBusy.current = true;
    try {
      const response = await fetch("/api/auto-option-trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          maxTrades: autoMaxTrades,
          minimumLoss: autoMinimumLoss,
          minimumProfit: autoMinimumProfit,
          spot: candleSnapshot.at(-1)?.close ?? 0,
          candles: candleSnapshot.slice(-72).map((candle) => ({ ...candle, timestamp: new Date(candle.time * 1000).toISOString() })),
          contracts: candidateSnapshot,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setAutoTradeStatus((current) => ({ ...current, summary: data.error ?? "Auto scan blocked" })); return; }
      setAutoTradeStatus({ tradesTaken: data.tradesTaken ?? 0, limitHit: Boolean(data.limitHit), summary: data.summary ?? "Auto engine scanned the market", diagnostics: data.diagnostics ?? [], suggestions: data.suggestions ?? [] });
      if (Array.isArray(data.orders) && data.orders.length) {
        const activeOrders = data.orders.filter((order: Order) => ["OPEN", "FILLED"].includes(order.status));
        setOrders((current) => [...activeOrders, ...current.filter((order) => !data.orders.some((next: Order) => next.id === order.id))]);
        setOrderHistory((current) => [...data.orders, ...current.filter((order) => !data.orders.some((next: Order) => next.id === order.id))]);
      }
      setAlgoLogs((current) => [{ time: new Date().toLocaleTimeString("en-IN"), text: `[Auto option engine] ${data.summary ?? "Market scanned"}`, type: data.limitHit ? "info" : "entry" }, ...current]);
    } catch { setAutoTradeStatus((current) => ({ ...current, summary: "Auto scan unavailable; market data is being retried" })); }
    finally { autoScanBusy.current = false; }
  }, [analysis?.session, autoMaxTrades, autoMinimumLoss, autoMinimumProfit, autoTradeEnabled, symbol]);

  const scheduleAutoOptionScan = useCallback((candleSnapshot = marketCandlesRef.current, candidateSnapshot = optionCandidatesRef.current) => {
    if (!autoTradeEnabled) return;
    if (autoScanTimer.current) clearTimeout(autoScanTimer.current);
    autoScanTimer.current = setTimeout(() => {
      autoScanTimer.current = null;
      void runAutoOptionScan(candleSnapshot, candidateSnapshot);
    }, 250);
  }, [autoTradeEnabled, runAutoOptionScan]);

  const searchOptions = useCallback(async () => {
    const search = query.trim().toUpperCase();
    setSearched(true);
    if (search.length < 2) { setOptions([]); return; }
    setSearching(true);
    try {
      const data = await fetch(`/api/groww-instruments?q=${encodeURIComponent(search)}`, { cache: "no-store" }).then((response) => response.json());
      setOptions(Array.isArray(data.instruments) ? data.instruments : []);
    } catch { setOptions([]); }
    finally { setSearching(false); }
  }, [query]);

  async function placePaperOrder() {
    let targetContract = selected;
    if (!targetContract) {
      const candidateMatch = optionCandidates.find((c) => c.symbol.toUpperCase() === query.trim().toUpperCase());
      const optionMatch = options.find((o) => o.symbol.toUpperCase() === query.trim().toUpperCase());
      if (optionMatch) {
        targetContract = {
          symbol: optionMatch.symbol,
          growwSymbol: optionMatch.growwSymbol,
          type: optionMatch.type,
          expiry: optionMatch.expiry,
          strike: optionMatch.strike,
          lotSize: optionMatch.lotSize,
        };
        setSelected(targetContract);
      } else if (candidateMatch) {
        targetContract = {
          symbol: candidateMatch.symbol,
          growwSymbol: candidateMatch.symbol,
          type: candidateMatch.contract === "CALL" ? "CE" : "PE",
          expiry: candidateMatch.expiry,
          strike: candidateMatch.strike,
          lotSize: candidateMatch.lotSize,
        };
        setSelected(targetContract);
      } else if (suggestedOption) {
        targetContract = {
          symbol: suggestedOption.symbol,
          growwSymbol: suggestedOption.symbol,
          type: suggestedOption.contract === "CALL" ? "CE" : "PE",
          expiry: suggestedOption.expiry,
          strike: suggestedOption.strike,
          lotSize: suggestedOption.lotSize,
        };
        setSelected(targetContract);
      } else if (chainRows.length > 0) {
        const topRow = chainRows[0];
        targetContract = {
          symbol: topRow.symbol,
          growwSymbol: topRow.symbol,
          type: topRow.contract === "CALL" ? "CE" : "PE",
          expiry: topRow.expiry,
          strike: topRow.strike,
          lotSize: topRow.lotSize,
        };
        setSelected(targetContract);
      }
    }
    if (!targetContract) {
      setMessage("⚠️ Please search and select an option contract or click 'Use suggestion' first.");
      return;
    }

    if (!targetContract.tickSize || !targetContract.freezeQuantity || targetContract.active === undefined) {
      try {
        const metadata = await fetch(`/api/groww-instruments?q=${encodeURIComponent(targetContract.symbol)}`, { cache: "no-store" }).then((response) => response.json());
        const exact = (metadata.instruments ?? []).find((instrument: Option) => instrument.symbol === targetContract?.symbol);
        if (exact) {
          targetContract = { ...targetContract, ...exact };
          setSelected(targetContract);
        }
      } catch { /* The API below returns a precise metadata error if enrichment fails. */ }
    }
    
    const lot = targetContract.lotSize;
    if (!lot || lot <= 0) {
      setMessage("Entry blocked: live contract metadata did not provide a valid lot size.");
      return;
    }
    const orderQty = quantity % lot === 0 && quantity > 0 ? quantity : Math.max(lot, Math.round(quantity / lot) * lot);
    if (orderQty !== quantity) {
      setQuantity(orderQty);
    }
    if (!selectedStrategy.directional) { setMessage("Range Defined Risk is analysis-only until its multi-leg contract builder is enabled. No naked option selling is permitted."); return; }
    
    if (analysis?.decision !== "CONFIRMED") {
      setAlgoLogs((prev) => [{ time: new Date().toLocaleTimeString("en-IN"), text: "Manual entry: the V5 algo pipeline is not CONFIRMED; placing a user-authorized manual paper order (kill-switch, SAFE MODE, broker, contract-master, and 2R risk checks still apply).", type: "info" }, ...prev]);
    }
    
    const candidateMatch = optionCandidates.find((c) => c.symbol === targetContract.symbol);
    const optionPrice = candidateMatch?.premium && candidateMatch.premium > 0 ? candidateMatch.premium : targetContract.strike ? 120 : (analysis?.setup?.entry ?? liveSpotPrice);
    const orderPrice = Number.isFinite(optionPrice) && optionPrice > 0 ? optionPrice : (analysis?.setup?.entry ?? liveSpotPrice);
    
    const target = Number(takeProfit || (orderPrice > 0 ? orderPrice * 1.3 : 150));
    const stop = Number(stopLoss || (orderPrice > 0 ? Math.max(orderPrice * 0.85, 0.05) : 80));
    
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(stop) || stop <= 0) {
      setMessage("Enter positive Take Profit and Stop Loss values.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/algo-trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "PAPER",
          orderSource: "MANUAL",
          strategy: selectedStrategy.id,
          strategyName: selectedStrategy.name,
          underlying: symbol,
          symbol: targetContract.symbol,
          side: "BUY",
          quantity: orderQty,
          price: orderPrice,
          target,
          stopLoss: stop,
          lotSize: lot,
          expiry: targetContract.expiry,
          growwSymbol: targetContract.growwSymbol,
          optionType: targetContract.type,
          strike: targetContract.strike,
          tickSize: targetContract.tickSize,
          freezeQuantity: targetContract.freezeQuantity,
          contractActive: targetContract.active,
          analysisDecision: analysis?.decision
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.order) { setMessage(data.error ?? "Paper order could not be placed."); return; }
      orderMutationVersion.current += 1;
      setOrders((current) => [data.order as Order, ...current]);
      setOrderHistory((current) => [data.order as Order, ...current.filter((o) => o.id !== data.order.id)]);
      setSelectedOrderId(data.order.id);
      setAlgoLogs((prev) => [
        {
          time: new Date().toLocaleTimeString("en-IN"),
          text: `[Firestore Saved] Order placed: ${data.order.symbol} (${selectedStrategy.name}) @ ₹${orderPrice} Qty: ${orderQty}`,
          type: "entry",
        },
        ...prev,
      ]);
      setMessage(`Paper order placed & saved to Firestore: ${data.order.symbol} @ ₹${orderPrice} (Qty: ${orderQty})`);
    } catch { setMessage("Paper order request failed. Check that the API is running."); }
    finally { setBusy(false); }
  }

  async function exitPaperOrder(order: Order) {
    setBusy(true);
    try {
      const response = await fetch(`/api/algo-trading?id=${encodeURIComponent(order.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage(data.error ?? "Trade could not be exited."); return; }
      orderMutationVersion.current += 1;
      setOrders((current) => current.filter((item) => item.id !== order.id));
      if (data.order) {
        setOrderHistory((current) => [data.order as Order, ...current.filter((o) => o.id !== order.id)]);
      }
      if (selectedOrderId === order.id) setSelectedOrderId(null);
      setAlgoLogs((prev) => [
        {
          time: new Date().toLocaleTimeString("en-IN"),
          text: `[Firestore Updated] Exited ${order.symbol} (P&L: ₹${data.order?.realizedPnl ?? order.pnl ?? 0})`,
          type: "exit",
        },
        ...prev,
      ]);
      setMessage(`Paper trade exited & recorded in Firestore: ${order.symbol}`);
    } catch { setMessage("Exit request failed. Check that the API is running."); }
    finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, [symbol, strategyId]);
  useEffect(() => {
    if (!orders.length) return;

    const pendingExit = orders.find((order) => {
      if (!order || !["OPEN", "FILLED"].includes(order.status)) return false;
      if (!order.symbol || !order.price || !order.stopLoss) return false;
      const matchingContract = optionCandidates.find((candidate) => normalizeSymbolKey(candidate.symbol) === normalizeSymbolKey(order.symbol));
      const premium = matchingContract?.premium ?? Number(order.currentPrice ?? order.price ?? 0);
      const exitState = getOrderExitState(order, premium);
      return exitState.hitStop || exitState.hitTarget;
    });

    if (!pendingExit) return;

    void exitPaperOrder(pendingExit);
  }, [optionCandidates, orders]);
  useEffect(() => {
    const update = () => setIstClock(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setChainStatus("Loading market data...");
    Promise.all([
      fetch(`/api/market-data/history?provider=${provider}&symbol=${encodeURIComponent(symbol)}&timeframe=5m&period=day&date=${istDate()}`, { cache: "no-store" }).then((response) => response.json()),
      ["NIFTY", "BANKNIFTY", "SENSEX"].includes(symbol) ? fetch(`/api/options-engine?provider=${provider}&symbols=${symbol}`, { cache: "no-store" }).then((response) => response.json()) : Promise.resolve({ candidates: [], error: "Options are not available for this underlying." }),
    ]).then(async ([history, chain]) => {
      if (cancelled) return;
      const historyCandles = Array.isArray(history.candles) ? history.candles : [];
      marketCandlesRef.current = historyCandles;
      setMarketCandles(historyCandles);
      if (history.error) {
        setChainStatus(`Groww market data unavailable · ${history.error}`);
        setOptionCandidates([]);
        return;
      }
      let candidates = Array.isArray(chain.candidates) ? chain.candidates : [];
      const rawChainError = typeof chain.error === "string" ? chain.error : "";
      let status = rawChainError && /429|rate limit|throttl|timeout|temporary|temporar|failed|unavailable/i.test(rawChainError)
        ? "No actionable option candidates · market data is temporarily throttled"
        : candidates.length ? `Live ${symbol} option chain` : "No actionable option candidates";
      if (!candidates.length && ["NIFTY", "BANKNIFTY", "SENSEX"].includes(symbol)) {
        const fallback = await fetch(`/api/option-chain?symbol=${symbol}`, { cache: "no-store" }).then((response) => response.json());
        candidates = (fallback.contracts ?? []).map((contract: OptionCandidate) => ({ ...contract, reason: contract.reason ?? "Real-time option-chain evidence" }));
        const rawFallbackError = typeof fallback.error === "string" ? fallback.error : "";
        status = candidates.length ? `Live ${symbol} option chain · ${fallback.expiry}` : rawFallbackError && /429|rate limit|throttl|timeout|temporary|temporar|failed|unavailable/i.test(rawFallbackError)
          ? "No actionable option candidates · market data is temporarily throttled"
          : "No actionable option candidates";
      }
      optionCandidatesRef.current = candidates;
      setOptionCandidates(candidates);
      setChainStatus(status);
    }).catch(() => { if (!cancelled) setChainStatus("Market data unavailable"); });
    return () => { cancelled = true; };
  }, [symbol, provider]);
  useEffect(() => () => {
    if (autoScanTimer.current) clearTimeout(autoScanTimer.current);
  }, []);
  const orderSymbols = useMemo(() => Array.from(new Set(orders.map((order) => normalizeSymbolKey(order.symbol)).filter(Boolean))).sort(), [orders]);
  const chainSymbols = useMemo(() => Array.from(new Set(optionCandidates.map((candidate) => normalizeSymbolKey(candidate.symbol)).filter(Boolean))).sort(), [optionCandidates]);
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(process.env.NEXT_PUBLIC_API_WS_URL ?? `${protocol}://${window.location.hostname}:4000/ws/quotes`);
    socket.onopen = () => {
      setStreamStatus("Live market and option data connected");
      socket.send(JSON.stringify({
        underlying: symbol,
        marketSymbols: ["NIFTY", "BANKNIFTY", "SENSEX", "INDIA VIX"],
        optionSymbols: chainSymbols,
        tradeSymbols: orderSymbols,
      }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type?: string; quote?: QuoteUpdate; quotes?: QuoteUpdate[] };
      if (message.type === "markets" && Array.isArray(message.quotes)) {
        const map: Record<string, number> = {};
        for (const item of message.quotes) {
          if (item.symbol && item.price !== null && item.price !== undefined) {
            map[item.symbol] = item.price;
          }
        }
        setMarketQuotes((current) => ({ ...current, ...map }));
      }
      if (message.type === "market" && message.quote?.price !== null && message.quote?.price !== undefined) {
        const price = message.quote.price;
        const quoteSymbol = message.quote.symbol || symbol;
        setMarketQuotes((current) => ({ ...current, [quoteSymbol]: price }));
        let nextCandles: Candle[] = [];
        setMarketCandles((current) => {
          if (!current.length) return [{ time: Math.floor(Date.now() / 1000), open: price, high: price, low: price, close: price, volume: 0 }];
          const last = current[current.length - 1];
          const now = Math.floor(Date.now() / 300000) * 300;
          if (last.time >= now) nextCandles = [...current.slice(0, -1), { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }];
          else nextCandles = [...current.slice(-71), { time: now, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 }];
          marketCandlesRef.current = nextCandles;
          return nextCandles;
        });
        if (!nextCandles.length) nextCandles = [{ time: Math.floor(Date.now() / 1000), open: price, high: price, low: price, close: price, volume: 0 }];
        marketCandlesRef.current = nextCandles;
        setAnalysis((current) => liveAnalysis(current, nextCandles));
        scheduleAutoOptionScan(nextCandles, optionCandidatesRef.current);
        return;
      }
      if (message.type === "chain" && message.quotes) {
        const nextCandidates = optionCandidatesRef.current.map((candidate) => { const update = message.quotes?.find((quote) => quote.symbol === candidate.symbol); return update?.price ? { ...candidate, premium: update.price, bid: update.price, ask: update.price } : candidate; });
        optionCandidatesRef.current = nextCandidates;
        setOptionCandidates(nextCandidates);
        
        scheduleAutoOptionScan(marketCandlesRef.current, nextCandidates);
        return;
      }
      if (message.type !== "quotes" || !message.quotes) return;
      const refreshedCandidates = optionCandidatesRef.current.map((candidate) => {
        const update = message.quotes?.find((quote) => normalizeSymbolKey(quote.symbol) === normalizeSymbolKey(candidate.symbol));
        return update?.price && update.price > 0 ? { ...candidate, premium: update.price, bid: update.price, ask: update.price } : candidate;
      });
      optionCandidatesRef.current = refreshedCandidates;
      setOptionCandidates(refreshedCandidates);
      
      scheduleAutoOptionScan(marketCandlesRef.current, refreshedCandidates);
      setOrders((current) => current.map((order) => {
        const update = message.quotes?.find((quote) => normalizeSymbolKey(quote.symbol) === normalizeSymbolKey(order.symbol));
        if (!update || update.price === null) return order;
        const direction = order.side.toUpperCase() === "SELL" ? -1 : 1;
        const pnl = (update.price - order.price) * order.quantity * direction;
        return { ...order, currentPrice: update.price, pnl, pnlPercent: order.price ? (update.price - order.price) / order.price * 100 * direction : 0, quoteSource: update.source };
      }));
    };
    socket.onerror = () => setStreamStatus("Live stream unavailable; REST refresh remains active");
    socket.onclose = () => setStreamStatus("Live stream unavailable; REST refresh remains active");
    return () => socket.close();
  }, [symbol, orderSymbols, chainSymbols, autoTradeEnabled]);
  const liveSpotPrice = marketCandles.at(-1)?.close ?? marketQuotes[symbol] ?? 0;
  const entry = analysis?.setup?.entry ?? liveSpotPrice;
  const atr = Number(analysis?.calculations?.underlying?.atr14 ?? 0);
  const target = analysis?.setup?.target ?? (entry > 0 ? entry + (atr > 0 ? atr * 2 : 20) : 0);
  const stop = analysis?.setup?.stop_loss ?? (entry > 0 ? Math.max(entry - (atr > 0 ? atr : 10), 0.05) : 0);
  const targetValue = takeProfit || (target > 0 ? String(target) : "");
  const stopValue = stopLoss || (stop > 0 ? String(stop) : "");
  const visibleOpenOrders = useMemo(() => {
    const autoOrders = orders
      .filter((order) => order.strategy === "AUTO_OPTION_ENGINE" && ["OPEN", "FILLED"].includes(order.status))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    const autoOrderIds = new Set(autoOrders.slice(0, autoMaxTrades).map((order) => order.id));
    return orders.filter((order) => order.strategy !== "AUTO_OPTION_ENGINE" || autoOrderIds.has(order.id));
  }, [autoMaxTrades, orders]);
  const visibleHistory = useMemo(() => {
    const visibleIds = new Set(visibleOpenOrders.map((order) => order.id));
    return orderHistory.filter((order) => order.strategy !== "AUTO_OPTION_ENGINE" || order.status === "EXITED" || order.status === "CANCELLED" || order.status === "SIMULATED" || visibleIds.has(order.id));
  }, [orderHistory, visibleOpenOrders]);
  const totalPnl = useMemo(() => visibleOpenOrders.reduce((sum, order) => sum + (order.pnl ?? 0), 0), [visibleOpenOrders]);
  const previewOrder = useMemo(() => orders.find((order) => order.id === selectedOrderId) ?? orders[0], [orders, selectedOrderId]);
  const previewEntry = previewOrder?.price ?? entry;
  const previewTarget = previewOrder?.target ?? target;
  const previewStop = previewOrder?.stopLoss ?? stop;
  const previewPrice = previewOrder?.currentPrice ?? (liveSpotPrice || previewEntry);
  const previewRisk = Math.abs(previewEntry - previewStop);
  const previewReward = Math.abs(previewTarget - previewEntry);
  const riskReward = previewRisk > 0 ? previewReward / previewRisk : 0;
  const previewCandles = useMemo(() => marketCandles.slice(-18), [marketCandles]);
  const previewCandlePrices = useMemo(() => previewCandles.flatMap((c) => [c.low, c.high]), [previewCandles]);
  const previewLow = useMemo(() => Math.min(...(previewCandlePrices.length ? previewCandlePrices : [previewEntry, previewTarget, previewStop, previewPrice].filter((v) => v > 0))), [previewCandlePrices, previewEntry, previewPrice, previewStop, previewTarget]);
  const previewHigh = useMemo(() => Math.max(...(previewCandlePrices.length ? previewCandlePrices : [previewEntry, previewTarget, previewStop, previewPrice].filter((v) => v > 0))), [previewCandlePrices, previewEntry, previewPrice, previewStop, previewTarget]);
  const previewRange = Math.max(previewHigh - previewLow, 0.01);
  const chartY = (value: number) => `${((previewHigh - value) / previewRange) * 100}%`;
  const overviewCandles = useMemo(() => marketCandles.slice(-36), [marketCandles]);
  const overviewPrices = useMemo(() => overviewCandles.length ? overviewCandles.flatMap((candle) => [candle.low, candle.high]) : (entry > 0 ? [entry * 0.995, entry * 1.005] : [100, 105]), [overviewCandles, entry]);
  const overviewLow = useMemo(() => Math.min(...overviewPrices), [overviewPrices]);
  const overviewHigh = useMemo(() => Math.max(...overviewPrices), [overviewPrices]);
  const overviewRange = Math.max(overviewHigh - overviewLow, 0.01);
  const underlyingCalculations = analysis?.calculations?.underlying;
  const marketBias = useMemo(() => analysis?.setup?.side?.toUpperCase().includes("SHORT") || (
    underlyingCalculations?.ema20 !== null && underlyingCalculations?.ema20 !== undefined &&
    underlyingCalculations?.ema50 !== null && underlyingCalculations?.ema50 !== undefined &&
    underlyingCalculations?.vwap !== null && underlyingCalculations?.vwap !== undefined &&
    underlyingCalculations?.last_price !== null && underlyingCalculations?.last_price !== undefined &&
    Number(underlyingCalculations.ema20) < Number(underlyingCalculations.ema50) && Number(underlyingCalculations.last_price) < Number(underlyingCalculations.vwap)
  ) ? "PUT" : analysis?.setup?.side?.toUpperCase().includes("LONG") || (
    underlyingCalculations?.ema20 !== null && underlyingCalculations?.ema20 !== undefined &&
    underlyingCalculations?.ema50 !== null && underlyingCalculations?.ema50 !== undefined &&
    underlyingCalculations?.vwap !== null && underlyingCalculations?.vwap !== undefined &&
    underlyingCalculations?.last_price !== null && underlyingCalculations?.last_price !== undefined &&
    Number(underlyingCalculations.ema20) > Number(underlyingCalculations.ema50) && Number(underlyingCalculations.last_price) > Number(underlyingCalculations.vwap)
  ) ? "CALL" : undefined, [analysis, underlyingCalculations]);
  const biasCandidates = useMemo(() => marketBias ? optionCandidates.filter((candidate) => candidate.contract === marketBias) : optionCandidates, [marketBias, optionCandidates]);
  const suggestedOption = useMemo(() => (biasCandidates.length ? biasCandidates : optionCandidates).slice().sort((left, right) => (right.final_score ?? right.score) - (left.final_score ?? left.score))[0], [biasCandidates, optionCandidates]);
  const alternativeCandidates = useMemo(() => optionCandidates.slice().sort((left, right) => (right.final_score ?? right.score) - (left.final_score ?? left.score)).slice(1, 4), [optionCandidates]);
  const chainRows = useMemo(() => optionCandidates.slice().sort((left, right) => left.strike - right.strike).slice(0, 12), [optionCandidates]);
  const dynamicStrategyMetrics = useMemo(() => [
    { label: "Setup", value: selectedStrategy.name },
    {
      label: "Regime",
      value: analysis?.calculations?.underlying?.adx14 !== null && analysis?.calculations?.underlying?.adx14 !== undefined
        ? `${Number(analysis.calculations.underlying.adx14) >= 22 ? "Trending" : Number(analysis.calculations.underlying.adx14) < 16 ? "Range" : "Chop"} (ADX ${Number(analysis.calculations.underlying.adx14).toFixed(1)})`
        : analysis?.decision ?? "Evaluating",
    },
    {
      label: "Confirmation",
      value: analysis?.calculations?.underlying?.relative_volume !== null && analysis?.calculations?.underlying?.relative_volume !== undefined
        ? `Vol ${Number(analysis.calculations.underlying.relative_volume).toFixed(1)}x · VWAP ${Number(analysis.calculations.underlying.vwap ?? 0).toFixed(0)}`
        : "Live Streaming",
    },
    {
      label: "Live Exposure",
      value: `${visibleOpenOrders.length} pos • ${selected?.lotSize ?? quantity} qty lot`,
    },
  ], [analysis, quantity, selectedStrategy.name, selected?.lotSize, visibleOpenOrders.length]);
  const netPositions = useMemo(() => {
    const positionsMap = new Map<string, { symbol: string; side: string; quantity: number; avgPrice: number; currentPrice: number; pnl: number; pnlPercent: number; strategy: string }>();
    visibleOpenOrders.forEach((o) => {
      const cur = o.currentPrice ?? o.price;
      const pnl = o.pnl ?? 0;
      const existing = positionsMap.get(o.symbol);
      if (!existing) {
        positionsMap.set(o.symbol, {
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          avgPrice: o.price,
          currentPrice: cur,
          pnl,
          pnlPercent: o.pnlPercent ?? 0,
          strategy: o.strategyName ?? o.strategy ?? "ORB + Retest",
        });
      } else {
        existing.quantity += o.quantity;
        existing.pnl += pnl;
      }
    });
    return Array.from(positionsMap.values());
  }, [visibleOpenOrders]);
  const sessionGatePassed = analysis?.pipeline?.gates.find((gate) => gate.code === "SESSION_BLOCKED")?.passed;
  const marketStatus = useMemo(() => analysis?.session
    ? !analysis.session.market_open
      ? "MARKET CLOSED"
      : analysis.session.entry_permitted
        ? "SESSION OPEN"
        : "ENTRY WINDOW CLOSED"
    : sessionGatePassed
      ? "SESSION OPEN"
      : "SESSION NOT OPEN", [analysis, sessionGatePassed]);
  const marketStatusTone = marketStatus === "SESSION OPEN" ? "gain" : "warning";

  const switchIndex = (next: string) => { setSymbol(next); setQuery(next); setSelected(null); setOptions([]); };
  const loadIntelPlan = (plan: TradePlan, context: { symbol: string; expiry: string | null; lotSize: number | null }) => {
    const contract = plan.contract;
    if (!contract || !plan.premium) return;
    const lot = context.lotSize && context.lotSize > 0 ? context.lotSize : fallbackLot(context.symbol);
    const lots = plan.lots && plan.lots > 0 ? plan.lots : 1;
    setSelected({ symbol: contract.trading_symbol, growwSymbol: contract.trading_symbol, type: contract.side, expiry: context.expiry ?? undefined, strike: contract.strike, lotSize: lot });
    setQuery(contract.trading_symbol);
    setQuantity(lot * lots);
    setTakeProfit(String(plan.premium.target1));
    setStopLoss(String(plan.premium.stop));
    setOptions([]);
    setSearched(true);
    setMessage(`Market-intel plan loaded: BUY ${contract.trading_symbol} · SL ₹${plan.premium.stop} · T1 ₹${plan.premium.target1} · ${lots} lot(s). Status ${plan.status}${plan.status === "READY" ? "" : " — practise in paper mode only"}.`);
  };
  return <main className="algo-page">
    <aside className="algo-sidebar"><div className="algo-brand"><b>AlgoTrade</b><small>Trade Smarter. Automate Better.</small></div>{["Dashboard", "Trade", "Strategies", "Option Chain", "Backtest", "Orders", "Positions", "Performance", "Alerts", "Groww Connect", "Settings"].map((item) => <button className={item === "Trade" ? "active" : ""} key={item}>{item}</button>)}</aside>
    <section className="algo-main">
      <header className="algo-topbar"><input aria-label="Search symbol" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="Search symbol (e.g. NIFTY, BANKNIFTY, RELIANCE...)" /><div className="algo-ticker">{["NIFTY", "BANKNIFTY", "SENSEX", "INDIA VIX"].map((item) => <span key={item}><b>{item}</b><small>{marketQuotes[item] ? `₹${money(marketQuotes[item])}` : "Live monitored"}</small></span>)}</div><div className="algo-account"><small>Groww available margin</small><b>{account?.available !== null && account?.available !== undefined ? `₹${money(account.available)}` : "Groww API connected"}</b><em>{account?.source ?? "Paper-safe until live gates are approved"}</em></div></header>
      <div className="algo-content"><div className="algo-toolbar"><div><span className="algo-kicker">ALGO EXECUTION WORKSPACE</span><h1>{symbol} strategy control</h1><p>{message} · {streamStatus}</p></div><div className="algo-controls"><span className="provider-badge">Data &amp; execution provider: Groww (live)</span><label className="auto-trade-toggle"><input type="checkbox" checked={autoTradeEnabled} onChange={(event) => { setAutoTradeEnabled(event.target.checked); setAutoTradeStatus((current) => ({ ...current, summary: event.target.checked ? "Auto engine starting its market scan" : "Auto engine is disabled" })); }} /> <b>Auto trade</b><small>paper only · max {autoMaxTrades}</small></label><button onClick={refresh} disabled={busy}>{busy ? "Updating..." : "Refresh analysis"}</button></div></div>
        <article className="algo-panel control-bar">
          <div className="control-bar-item"><small>Instrument</small><b>{symbol}</b></div>
          <div className="control-bar-item"><small>Market status</small><b className={marketStatusTone}>{marketStatus}</b></div>
          <div className="control-bar-item"><small>IST time</small><b>{istClock || "--:--:--"}</b></div>
          <div className="control-bar-item"><small>Strategy</small><b>{selectedStrategy.name} · V5</b></div>
          <div className="control-bar-item"><small>Execution mode</small><b className={executionMode === "ALGO_LIVE" ? (liveExecution ? "loss" : "warning") : "gain"}>{executionMode === "ALGO_LIVE" ? (liveExecution ? "LIVE" : "LIVE_DISABLED") : "PAPER"}</b></div>
          <div className={`control-bar-item${autoTradeEnabled ? " control-alert" : ""}`}><small>Auto option engine</small><b className={autoTradeStatus.limitHit ? "warning" : autoTradeEnabled ? "gain" : "warning"}>{autoTradeEnabled ? `${autoTradeStatus.tradesTaken}/${autoMaxTrades} ${autoTradeStatus.limitHit ? "SUGGEST" : "TRACKING"}` : "OFF"}</b></div>
          <div className="control-bar-item"><small>Data feed / broker</small><b className={streamStatus.includes("connected") || streamStatus.includes("Connected") ? "gain" : "warning"}>{streamStatus.includes("unavailable") ? "GROWW UNAVAILABLE" : "GROWW CONNECTED"}</b></div>
          <div className="control-bar-item"><small>Reconciliation</small><b className="warning">NOT IMPLEMENTED</b></div>
          <div className={`control-bar-item${safeMode.active ? " control-alert" : ""}`}><small>SAFE MODE</small><b className={safeMode.active ? "loss" : "gain"}>{safeMode.active ? "ACTIVE" : "CLEAR"}</b></div>
          <div className={`control-bar-item${killSwitch.active ? " control-alert" : ""}`}><small>KILL SWITCH</small><b className={killSwitch.active ? "loss" : "gain"}>{killSwitch.active ? "ACTIVE" : "CLEAR"}</b></div>
        </article>
        <MarketIntelPanel symbol={symbol} onSymbolChange={switchIndex} onUsePlan={loadIntelPlan} />
        <article className="algo-panel auto-trade-panel"><div className="algo-panel-head"><div><span className="algo-kicker">AUTONOMOUS OPTION ENGINE</span><h2>Market tracking and trade plan</h2></div><span className={autoTradeStatus.limitHit ? "warning" : autoTradeEnabled ? "gain" : "neutral"}>{autoTradeEnabled ? (autoTradeStatus.limitHit ? "SUGGESTION ONLY" : "TRACKING") : "OFF"}</span></div><div className="auto-trade-settings"><label>Maximum open trades<select value={autoMaxTrades} onChange={(event) => setAutoMaxTrades(Number(event.target.value))}><option value={1}>1 trade</option><option value={2}>2 trades</option><option value={3}>3 trades</option><option value={4}>4 trades</option><option value={5}>5 trades</option></select></label><label>Minimum loss exit<select value={autoMinimumLoss} onChange={(event) => setAutoMinimumLoss(Number(event.target.value))}><option value={250}>₹250</option><option value={500}>₹500</option><option value={1000}>₹1,000</option><option value={1500}>₹1,500</option><option value={2000}>₹2,000</option><option value={2500}>₹2,500</option><option value={5000}>₹5,000</option></select></label><label>Minimum profit to trail<select value={autoMinimumProfit} onChange={(event) => setAutoMinimumProfit(Number(event.target.value))}><option value={0}>Immediate after 1R</option><option value={300}>₹300</option><option value={400}>₹400</option><option value={500}>₹500</option><option value={1000}>₹1,000</option><option value={1500}>₹1,500</option><option value={2500}>₹2,500</option></select></label></div><p className="auto-trade-summary">{autoTradeStatus.summary}. A minimum-loss breach exits immediately for capital protection; trend, 15-candle 5-minute structure, candlestick, volume, delta, and option-chain factors classify the exit. Trailing activates only after the selected profit threshold and never loosens.</p>{autoTradeStatus.diagnostics?.length ? <div className="auto-trade-diagnostics">{autoTradeStatus.diagnostics.slice(0, 4).map((diagnostic) => <small key={diagnostic}>{diagnostic}</small>)}</div> : null}{autoTradeStatus.suggestions.length > 0 && <div className="auto-trade-suggestions">{autoTradeStatus.suggestions.slice(-3).reverse().map((suggestion, index) => <span key={`${suggestion.symbol}-${index}`}><b>{suggestion.contract} · {suggestion.symbol}</b><small>Entry ₹{money(suggestion.entry)} · SL ₹{money(suggestion.stopLoss)} · Target ₹{money(suggestion.target)} · Score {suggestion.score}</small></span>)}</div>}</article>
        <div className="nifty-strategy-banner">
          <div>
            <span className="algo-kicker">NIFTY OPTIONS STRATEGY · V5</span>
            <label className="strategy-selector">Active strategy<select value={strategyId} onChange={(event) => setStrategyId(event.target.value as StrategyId)}>{strategies.map((strategy) => <option value={strategy.id} key={strategy.id}>{strategy.name}</option>)}</select></label>
            <h2>{selectedStrategy.name} · {selectedStrategy.shortName}</h2>
            <p>{selectedStrategy.description}</p>
          </div>
          <div className="nifty-strategy-metrics">
            {dynamicStrategyMetrics.map((item) => (
              <span key={item.label}><small>{item.label}</small><b>{item.value}</b></span>
            ))}
          </div>
        </div>
        <article className="algo-panel calculation-panel">
          <div className="algo-panel-head"><div><span className="algo-kicker">TRANSPARENT SIGNAL LEDGER</span><h2>Market calculations</h2></div><span>{analysis?.decision ?? "WAITING"}</span></div>
          <div className="calculation-grid">
            <section><b>Underlying structure</b><span>Last price <strong>{calculationValue(analysis?.calculations?.underlying?.last_price)}</strong></span><span>VWAP <strong>{calculationValue(analysis?.calculations?.underlying?.vwap)}</strong></span><span>EMA 20 / 50 <strong>{calculationValue(analysis?.calculations?.underlying?.ema20)} / {calculationValue(analysis?.calculations?.underlying?.ema50)}</strong></span><span>ADX (14) <strong>{calculationValue(analysis?.calculations?.underlying?.adx14)}</strong></span><span>ATR (14) <strong>{calculationValue(analysis?.calculations?.underlying?.atr14)}</strong></span><span>Relative volume <strong>{calculationValue(analysis?.calculations?.underlying?.relative_volume, true)}</strong></span></section>
            <section><b>ORB and retest</b><span>Opening range high <strong>{calculationValue(analysis?.calculations?.orb?.opening_range_high)}</strong></span><span>Opening range low <strong>{calculationValue(analysis?.calculations?.orb?.opening_range_low)}</strong></span><span>Breakout <strong>{calculationValue(analysis?.calculations?.orb?.breakout_index)}</strong></span><span>Retest <strong>{calculationValue(analysis?.calculations?.orb?.retest_index)}</strong></span><span>Extension limit <strong>{calculationValue(analysis?.calculations?.orb?.max_extension)}</strong></span><span>Status <strong>{calculationValue(analysis?.calculations?.orb?.status)}</strong></span></section>
            <section><b>Signal score · max 10</b><span>Trend cluster <strong>{calculationValue(analysis?.calculations?.score?.trend_cluster)} / 3</strong></span><span>Structure cluster <strong>{calculationValue(analysis?.calculations?.score?.structure_cluster)} / 3</strong></span><span>Volume evidence <strong>{calculationValue(analysis?.calculations?.score?.volume_evidence)} / 2</strong></span><span>Option relative strength <strong>{calculationValue(analysis?.calculations?.score?.option_relative_strength)} / 1</strong></span><span>OI direction <strong>{calculationValue(analysis?.calculations?.score?.oi_direction)} / 1</strong></span><span>Total / minimum <strong>{calculationValue(analysis?.calculations?.score?.total)} / {calculationValue(analysis?.calculations?.score?.minimum)}</strong></span></section>
            <section><b>Options and risk gates</b><span>ORS <strong>{calculationValue(analysis?.calculations?.option?.ors)}</strong></span><span>OI / PCR score <strong>{calculationValue(analysis?.calculations?.option?.oi_direction_score)}</strong></span><span>IV / VIX regime <strong>{calculationValue(analysis?.calculations?.option?.iv_regime)}</strong></span><span>Liquidity score <strong>{calculationValue(analysis?.calculations?.option?.liquidity_score)} / 3</strong></span><span>Minimum R:R <strong>{calculationValue(analysis?.calculations?.risk?.minimum_reward_risk)}R</strong></span><span>Daily limits <strong>{calculationValue(analysis?.calculations?.risk?.max_trades_per_day)} trades · {calculationValue(analysis?.calculations?.risk?.daily_loss_limit_pct)}%</strong></span></section>
          </div>
          <div className="calculation-note"><b>Gap-day protocol:</b> {calculationValue(analysis?.calculations?.gap?.status)} · {calculationValue(analysis?.calculations?.gap?.reason)} <span>{analysis?.reason ?? "Waiting for market data"}</span></div>
        </article>
        <article className="algo-panel pipeline-panel">
          <div className="algo-panel-head"><div><span className="algo-kicker">V5 DECISION PIPELINE</span><h2>Every gate the backend authoritative pipeline evaluated</h2></div><span className={analysis?.pipeline?.decision === "CONFIRMED" ? "gain" : "warning"}>{analysis?.pipeline?.decision ?? "WAITING"}</span></div>
          <div className="pipeline-stage-list">
            {(analysis?.pipeline?.gates ?? []).map((gate) => (
              <div className={`pipeline-stage ${gate.passed ? "stage-pass" : "stage-fail"}`} key={gate.code}>
                <b>{gate.code.replaceAll("_", " ")}</b>
                <span className={gate.passed ? "gain" : "loss"}>{gate.passed ? "PASS" : "BLOCKED"}</span>
                <small>{gate.detail}</small>
              </div>
            ))}
            {!analysis?.pipeline?.gates.length && <div className="algo-empty">Waiting for the backend V5 pipeline to return evidence.</div>}
          </div>
        </article>
        <article className="algo-panel no-trade-panel">
          <div className="algo-panel-head"><div><span className="algo-kicker">NO-TRADE ENGINE</span><h2>All active blocking reasons</h2></div><span>{analysis?.pipeline?.reasons?.length ?? 0} reason(s)</span></div>
          {analysis?.pipeline?.reasons?.length ? (
            <ul className="no-trade-reasons">
              {analysis.pipeline.reasons.map((reason) => <li key={reason}>{reason.replaceAll("_", " ")}</li>)}
            </ul>
          ) : (
            <div className="algo-empty">{analysis?.pipeline?.decision === "CONFIRMED" ? "All gates passed. The plan is confirmed for paper execution." : "Waiting for pipeline evidence."}</div>
          )}
        </article>
        <section className="algo-grid">
          <article className="algo-panel algo-chart-panel"><div className="algo-panel-head"><div><span className="algo-kicker">{symbol} · 5M · NSE</span><h2>Market overview</h2></div><span className="algo-live">● {provider.toUpperCase()} MARKET</span></div><div className="algo-chart-toolbar"><button>1m</button><button className="selected">5m</button><button>15m</button><button>30m</button><button>1h</button><button>1D</button></div><div className="algo-chart-header"><b>{money(marketCandles.at(-1)?.close ?? entry)}</b><span className={(marketCandles.at(-1)?.close ?? entry) >= (marketCandles.at(-2)?.close ?? entry) ? "gain" : "loss"}>{marketCandles.length > 1 ? `${(marketCandles.at(-1)!.close - marketCandles.at(-2)!.close >= 0 ? "+" : "")}${money(marketCandles.at(-1)!.close - marketCandles.at(-2)!.close)}` : "Waiting for quote"}</span></div><div className="algo-market-chart"><div className="algo-chart-grid" />{overviewCandles.map((candle, index) => { const bullish = candle.close >= candle.open; const width = 88 / Math.max(overviewCandles.length, 1); const scale = (value: number) => `${((overviewHigh - value) / overviewRange) * 100}%`; return <div className={`overview-candle ${bullish ? "overview-up" : "overview-down"}`} key={`${candle.time}-${index}`} style={{ left: `${5 + index * width}%`, top: scale(candle.high), height: `${Math.max((candle.high - candle.low) / overviewRange * 82, 2)}%` }}><i style={{ height: "100%" }} /><b style={{ top: `${(candle.high - Math.max(candle.open, candle.close)) / Math.max(candle.high - candle.low, 0.01) * 100}%`, height: `${Math.max(Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, 0.01) * 100, 4)}%` }} /><em style={{ height: `${20 + (index * 17) % 70}%` }} /></div>; })}<span className="algo-chart-last">{money(marketCandles.at(-1)?.close ?? entry)}</span></div><div className="algo-metrics"><span>Setup <b className={analysis?.decision === "CONFIRMED" ? (analysis.setup?.side === "SELL" ? "loss" : "gain") : "warning"}>{analysis?.decision === "CONFIRMED" ? (analysis.setup?.side === "SELL" ? "BEARISH (PE)" : "BULLISH (CE)") : "WAITING"}</b></span><span>VWAP <b>{money(analysis?.indicators?.vwap ?? marketCandles.at(-1)?.close ?? entry)}</b></span><span>Support <b>{money(analysis?.levels?.support ?? overviewLow)}</b></span><span>Resistance <b>{money(analysis?.levels?.resistance ?? overviewHigh)}</b></span></div></article>
          <article className="algo-panel algo-chain"><div className="algo-panel-head"><h2>Option Chain · {symbol}</h2><span>{chainStatus}</span></div>{suggestedOption ? <div className="premium-suggestion"><div className="suggestion-summary"><div><span>Suggested premium {suggestedOption.contract}</span><b>{suggestedOption.symbol} · {money(suggestedOption.premium)}</b><small>Strike {money(suggestedOption.strike)} · Delta {Number(suggestedOption.delta ?? 0).toFixed(2)} · Score {Math.round(suggestedOption.final_score ?? suggestedOption.score)} · R:R {Number(suggestedOption.riskReward ?? 0).toFixed(2)}</small></div><button type="button" onClick={() => { const defaultLot = fallbackLot(symbol); const lot = suggestedOption.lotSize && suggestedOption.lotSize > 0 ? suggestedOption.lotSize : defaultLot; setSelected({ symbol: suggestedOption.symbol, growwSymbol: suggestedOption.symbol, type: suggestedOption.contract === "CALL" ? "CE" : "PE", expiry: suggestedOption.expiry, strike: suggestedOption.strike, lotSize: lot }); setQuery(suggestedOption.symbol); setQuantity(lot); setOptions([]); setSearched(true); if (suggestedOption.premium > 0) { setTakeProfit(String(Math.round(suggestedOption.premium * 1.3))); setStopLoss(String(Math.round(suggestedOption.premium * 0.85))); } setMessage(`Suggested ${suggestedOption.contract} selected: ${suggestedOption.symbol} (Lot ${lot})`); }}>Use suggestion</button></div><div className="suggestion-grid"><span>Setup score <strong>{Math.round(suggestedOption.final_score ?? suggestedOption.score)}/100</strong></span><span>Confidence <strong>{formatConfidenceText(suggestedOption.confidence)}</strong></span><span>Direction <strong>{suggestedOption.direction ?? (suggestedOption.contract === "CALL" ? "BULLISH" : "BEARISH")}</strong></span><span>Delta <strong>{Number(suggestedOption.delta ?? 0).toFixed(2)}</strong></span><span>IV <strong>{Number(suggestedOption.iv ?? 0).toFixed(1)}%</strong></span><span>Breakeven <strong>{money(suggestedOption.feasibility?.breakeven ?? (suggestedOption.strike + suggestedOption.premium))}</strong></span><span>Expected move <strong>{formatExpectedMoveText(suggestedOption.feasibility?.expected_move_points)}</strong></span><span>Required move <strong>{money(suggestedOption.feasibility?.required_move ?? 0)}</strong></span><span>Target <strong>{money(suggestedOption.target ?? suggestedOption.premium * 1.5)}</strong></span><span>Stop <strong>{money(suggestedOption.stop ?? suggestedOption.premium * 0.75)}</strong></span></div><div className="suggestion-explanations"><h3>Why this option?</h3><p>{suggestedOption.reason}</p><ul>{Object.entries(suggestedOption.pipeline?.score_breakdown ?? {}).map(([key, value]) => <li key={key}>{key.replaceAll("_", " ")} · {Number(value).toFixed(1)}</li>)}</ul>{(suggestedOption.warnings ?? []).length ? <div className="suggestion-warnings"><b>Warnings</b>{suggestedOption.warnings!.map((warning) => <small key={warning}>{warning}</small>)}</div> : null}</div>{alternativeCandidates.length ? <div className="suggestion-alternatives"><h3>Alternative strikes</h3>{alternativeCandidates.map((candidate) => <div key={`${candidate.symbol}-${candidate.contract}-${candidate.strike}`} className="alternative-option"><b>{candidate.symbol}</b><span>{candidate.contract}</span><strong>{Math.round(candidate.final_score ?? candidate.score)}/100</strong><small>Strike {money(candidate.strike)} · Delta {Number(candidate.delta ?? 0).toFixed(2)} · R:R {Number(candidate.riskReward ?? 0).toFixed(2)}</small></div>)}</div> : null}</div> : <div className="algo-empty">No actionable option candidate. Directional trend is weak, feasibility is poor, liquidity is insufficient, or the engine is waiting for fresher market data.</div>}<div className="algo-chain-table"><div><span>Type</span><span>Premium</span><span>Strike</span><span>IV</span><span>Score</span></div>{chainRows.length ? chainRows.map((candidate) => <div key={`${candidate.symbol}-${candidate.contract}`}><span className={candidate.contract === "CALL" ? "gain" : "loss"}>{candidate.contract}</span><span>{money(candidate.premium)}</span><span>{money(candidate.strike)}</span><span>{candidate.iv.toFixed(1)}%</span><span>{candidate.score.toFixed(0)}</span></div>) : <div className="chain-empty">{chainStatus}</div>}</div></article>
          <article className="algo-panel algo-strategy"><div className="algo-panel-head"><h2>Create Strategy</h2><span>Paper builder</span></div><div className="algo-form-section"><b className="step-number">1</b><strong>Search and select option</strong><label>Call / Put symbol<input value={query} onChange={(event) => { setQuery(event.target.value.toUpperCase()); setSearched(false); }} onKeyDown={(event) => { if (event.key === "Enter") searchOptions(); }} placeholder="NIFTY, BANKNIFTY, CE or PE" /></label><button type="button" className="option-search-button" onClick={searchOptions} disabled={searching}>{searching ? "Searching..." : "Search options"}</button>{options.length > 0 && <div className="option-search-results">{options.slice(0, 8).map((option) => <button type="button" key={option.growwSymbol} onClick={() => { const defaultLot = fallbackLot(symbol); const lot = option.lotSize && option.lotSize > 0 ? option.lotSize : defaultLot; setSelected({ ...option, lotSize: lot }); setQuery(option.symbol); setQuantity(lot); setOptions([]); setSearched(true); setMessage(`Option selected: ${option.symbol}`); }}>{option.symbol}<small>{option.type} · {option.expiry} · Strike {option.strike} · Lot {option.lotSize ?? fallbackLot(symbol)}</small></button>)}</div>}{searched && !searching && options.length === 0 && <div className="option-search-empty">No Groww contracts matched. Try an underlying such as NIFTY, BANKNIFTY, or search CE/PE.</div>}{selected && <div className="selected-option"><b>{selected.symbol}</b><span>{selected.type} · Expiry {selected.expiry} · Strike {selected.strike}</span><small>Lot size {selected.lotSize ?? fallbackLot(symbol)} · {selected.growwSymbol}</small></div>}</div><div className="algo-form-section"><b className="step-number">2</b><strong>Set entry and exit rules</strong><label>Trigger<select value={triggerMode} onChange={(e) => setTriggerMode(e.target.value as "AUTO" | "MANUAL")}><option value="AUTO">On Signal (Auto - Gated by Market Strategy)</option><option value="MANUAL">Manual Test (Paper Simulation)</option></select></label><label>Take Profit (Target)<input type="number" value={targetValue} onChange={(event) => setTakeProfit(event.target.value)} placeholder="Target price (e.g. 165)" /></label><label>Stop Loss<input type="number" value={stopValue} onChange={(event) => setStopLoss(event.target.value)} placeholder="Stop price (e.g. 105)" /></label></div><div className="algo-form-section"><b className="step-number">3</b><strong>Position sizing</strong><label>Quantity<input type="number" min={selected?.lotSize ?? fallbackLot(symbol)} step={selected?.lotSize ?? fallbackLot(symbol)} value={quantity} onChange={(event) => setQuantity(Number(event.target.value) || (selected?.lotSize ?? fallbackLot(symbol)))} /></label></div><div className="algo-strategy-actions"><button type="button" className="algo-paper-submit" onClick={placePaperOrder} disabled={busy}>{busy ? "Processing..." : "Place Paper Order"}</button><small>Live execution requires explicit confirmation and compliance gates.</small></div></article>
          <article className="algo-panel algo-preview"><div className="algo-panel-head"><div><span className="algo-kicker">STRATEGY PREVIEW · CANDLESTICK</span><h2>{previewOrder?.symbol ?? selected?.symbol ?? symbol} · {previewOrder?.side ?? analysis?.setup?.side ?? "WAITING"}</h2></div><span className={riskReward >= 2 ? "gain" : riskReward >= 1 ? "warning" : "loss"}>R:R {riskReward.toFixed(2)}</span></div><div className="algo-preview-body"><div className="algo-preview-chart"><div className="risk-chart"><div className="risk-chart-grid" /><div className="risk-zone risk-zone-reward" style={{ top: chartY(previewTarget), height: `calc(${chartY(previewEntry)} - ${chartY(previewTarget)})` }} /><div className="risk-zone risk-zone-risk" style={{ top: chartY(previewEntry), height: `calc(${chartY(previewStop)} - ${chartY(previewEntry)})` }} /><div className="risk-candles">{previewCandles.length ? previewCandles.map((candle, index) => { const bullish = candle.close >= candle.open; const width = 82 / Math.max(previewCandles.length, 1); const candleHeight = Math.max(((candle.high - candle.low) / previewRange) * 100, 2); const bodyTop = ((candle.high - Math.max(candle.open, candle.close)) / Math.max(candle.high - candle.low, 0.01)) * 100; const bodyHeight = Math.max((Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, 0.01)) * 100, 4); return <div className="risk-candle" key={`${candle.time}-${index}`} style={{ left: `${7 + index * width}%`, top: chartY(candle.high), height: `${candleHeight}%` }}><i className="risk-wick" /><b className={bullish ? "candle-up" : "candle-down"} style={{ top: `${bodyTop}%`, height: `${bodyHeight}%` }} /><em style={{ height: `${Math.min(100, (candle.volume / Math.max(...previewCandles.map((c) => c.volume), 1)) * 100)}%` }} /></div>; }) : <div className="chain-empty">Awaiting live market candles</div>}</div><div className="risk-level risk-level-target" style={{ top: chartY(previewTarget) }}><span>Target {money(previewTarget)}</span></div><div className="risk-level risk-level-entry" style={{ top: chartY(previewEntry) }}><span>Entry {money(previewEntry)}</span></div><div className="risk-level risk-level-stop" style={{ top: chartY(previewStop) }}><span>Stop {money(previewStop)}</span></div><div className="risk-level risk-level-live" style={{ top: chartY(previewPrice) }}><span>LTP {money(previewPrice)}</span></div><div className="risk-chart-axis"><span>{money(previewHigh)}</span><span>{money((previewHigh + previewLow) / 2)}</span><span>{money(previewLow)}</span></div><div className="risk-chart-legend"><span className="legend-entry">Entry</span><span className="legend-target">Target</span><span className="legend-stop">Stop</span><span className="legend-live">Live LTP</span></div></div></div><div className="algo-logic"><h3>Risk / Reward <small>Live trade plan</small></h3><div className="risk-summary"><span className="gain">Potential profit<strong>{money(previewReward)}</strong></span><span className="loss">Defined risk<strong>{money(previewRisk)}</strong></span><span className={riskReward >= 2 ? "gain" : "warning"}>Ratio<strong>{riskReward.toFixed(2)} : 1</strong></span></div><p>Entry: {money(previewEntry)} · Current: {money(previewPrice)}</p><p>Target: {money(previewTarget)} · Stop: {money(previewStop)}</p><p>{previewOrder ? "Selected open paper trade is marked from the live quote stream." : "Select an open order to view its trade plan."}</p></div></div></article>
          <article className="algo-panel algo-orders">
            <div className="algo-order-tabs">
              <button className={orderTab === "OPEN" ? "selected" : ""} onClick={() => setOrderTab("OPEN")}>
                Open Orders <b>{visibleOpenOrders.length}</b>
              </button>
              <button className={orderTab === "POSITIONS" ? "selected" : ""} onClick={() => setOrderTab("POSITIONS")}>
                Positions <b>{netPositions.length}</b>
              </button>
              <button className={orderTab === "HISTORY" ? "selected" : ""} onClick={() => setOrderTab("HISTORY")}>
                Trade History <b>{visibleHistory.length}</b>
              </button>
              <button className={orderTab === "LOGS" ? "selected" : ""} onClick={() => setOrderTab("LOGS")}>
                Algo Logs <b>{algoLogs.length}</b>
              </button>
              {firestoreSynced && <span className="firestore-badge"><i /> Cloud Firestore Synced</span>}
              <strong className={totalPnl >= 0 ? "gain" : "loss"}>
                Unrealized P&amp;L {totalPnl >= 0 ? "+" : ""}{money(totalPnl)}
              </strong>
            </div>

            {orderTab === "OPEN" && (
              visibleOpenOrders.length ? visibleOpenOrders.map((order) => {
                const pnl = order.pnl ?? 0;
                const quoteAvailable = hasLiveQuote(order);
                return (
                  <div className={`algo-order ${selectedOrderId === order.id ? "selected-order" : ""}`} key={order.id}>
                    <label className="order-radio">
                      <input type="radio" name="preview-order" checked={selectedOrderId === order.id} onChange={() => setSelectedOrderId(order.id)} aria-label={`Show ${order.symbol} in strategy preview`} />
                      <span />
                    </label>
                    <b>{order.symbol} <span className="order-strategy-tag">{order.strategyName ?? order.strategy ?? "ORB"}</span></b>
                    <span>{order.side}</span>
                    <span>{order.quantity} qty</span>
                    <span>Entry ₹{money(order.price)}<small>LTP ₹{money(order.currentPrice ?? order.price)} | SL ₹{money(order.stopLoss ?? 0)} | TP ₹{money(order.target ?? 0)}{order.trailingActivatedAt ? ` | Trail ₹${money(order.trailingStop ?? order.stopLoss ?? 0)}` : ""}</small></span>
                    <strong className={pnl >= 0 ? "gain" : "loss"}>
                      {quoteAvailable ? `${pnl >= 0 ? "+" : ""}${money(pnl)} (${pnl >= 0 ? "+" : ""}${money(order.pnlPercent ?? 0)}%)` : "P&L awaiting live quote"}
                    </strong>
                    <em>{order.status}<button type="button" className="algo-exit" onClick={() => exitPaperOrder(order)} disabled={busy}>Exit</button></em>
                  </div>
                );
              }) : <div className="algo-empty">No active open orders. Use the Strategy Builder above to place an order into Cloud Firestore.</div>
            )}

            {orderTab === "POSITIONS" && (
              netPositions.length ? (
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Strategy</th>
                      <th>Side</th>
                      <th>Net Qty</th>
                      <th>Avg Price</th>
                      <th>LTP</th>
                      <th>Unrealized P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {netPositions.map((pos) => (
                      <tr key={pos.symbol}>
                        <td><b>{pos.symbol}</b></td>
                        <td><span className="order-strategy-tag">{pos.strategy}</span></td>
                        <td><span className={pos.side === "BUY" ? "gain" : "loss"}>{pos.side}</span></td>
                        <td>{pos.quantity}</td>
                        <td>₹{money(pos.avgPrice)}</td>
                        <td>₹{money(pos.currentPrice)}</td>
                        <td><b className={pos.pnl >= 0 ? "gain" : "loss"}>{pos.pnl >= 0 ? "+" : ""}₹{money(pos.pnl)} ({pos.pnl >= 0 ? "+" : ""}{pos.pnlPercent.toFixed(2)}%)</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="algo-empty">No open positions. All simulated trades have been squared off.</div>
            )}

            {orderTab === "HISTORY" && (
              visibleHistory.length ? (
                <table className="order-history-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Order ID</th>
                      <th>Symbol</th>
                      <th>Strategy</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Exit Price</th>
                      <th>Realized P&amp;L</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHistory.map((item) => (
                      <tr key={item.id}>
                        <td><small>{item.createdAt ? new Date(item.createdAt).toLocaleTimeString("en-IN") : "--"}</small></td>
                        <td><small>{item.id}</small></td>
                        <td><b>{item.symbol}</b></td>
                        <td><span className="order-strategy-tag">{item.strategyName ?? item.strategy ?? "ORB"}</span></td>
                        <td><span className={item.side === "BUY" ? "gain" : "loss"}>{item.side}</span></td>
                        <td>{item.quantity}</td>
                        <td>₹{money(item.price)}</td>
                        <td>{item.exitPrice ? `₹${money(item.exitPrice)}` : "--"}</td>
                        <td>
                          {item.realizedPnl !== undefined ? (
                            <b className={item.realizedPnl >= 0 ? "gain" : "loss"}>
                              {item.realizedPnl >= 0 ? "+" : ""}₹{money(item.realizedPnl)} ({item.realizedPnl >= 0 ? "+" : ""}{item.realizedPnlPercent ?? 0}%)
                            </b>
                          ) : item.pnl !== undefined ? (
                            <span className={item.pnl >= 0 ? "gain" : "loss"}>
                              {item.pnl >= 0 ? "+" : ""}₹{money(item.pnl)} (Live)
                            </span>
                          ) : "--"}
                        </td>
                        <td><em>{item.status}</em></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="algo-empty">No trade history recorded in Cloud Firestore yet.</div>
            )}

            {orderTab === "LOGS" && (
              <div className="algo-logs-list">
                {algoLogs.map((log, index) => (
                  <div className={`algo-log-entry ${log.type}`} key={index}>
                    <span className="algo-log-time">{log.time}</span>
                    <span>{log.text}</span>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
      </div>
    </section>
  </main>;
}
