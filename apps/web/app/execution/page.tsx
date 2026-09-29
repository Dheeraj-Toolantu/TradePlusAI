"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMarketCalculationValue, getOrderExitState } from "../../lib/option-chain-state";
import type { TradePlan } from "../../components/market-intel/market-intel-panel";
import type { LiveTicketDraft } from "../../components/live/live-order-dialog";

// Heavy, below-the-fold or on-demand panels load in their own chunks so the first paint only
// needs the header and the trade desk shell.
const MarketIntelPanel = dynamic(() => import("../../components/market-intel/market-intel-panel").then((module) => module.MarketIntelPanel), { ssr: false, loading: () => <div className="algo-empty">Loading trade desk…</div> });
const SentimentPanel = dynamic(() => import("../../components/market-intel/sentiment-panel").then((module) => module.SentimentPanel), { ssr: false });
const AIMonitoringPanel = dynamic(() => import("../../components/ai/ai-monitoring-panel").then((module) => module.AIMonitoringPanel), { ssr: false });
const LiveOrderDialog = dynamic(() => import("../../components/live/live-order-dialog").then((module) => module.LiveOrderDialog), { ssr: false });

type PipelineGate = { code: string; passed: boolean; detail: string };
type Analysis = {
  decision: string; reason?: string;
  setup?: { side: string; entry: number; stop_loss: number; target: number; risk_reward?: number; target_method?: string; stop_method?: string; size_multiplier?: number; gap_day?: boolean };
  calculations?: { underlying?: Record<string, number | null>; orb?: Record<string, number | string | null>; gap?: Record<string, number | string | null>; score?: Record<string, number | string | boolean | null>; risk?: Record<string, number | string | null>; option?: Record<string, number | string | null>; regime?: string };
  session?: { time_ist: string; trading_day: boolean; window: string; market_open: boolean; entry_permitted: boolean };
  pipeline?: { decision: string; reasons: string[]; gates: PipelineGate[] };
  strategy_decision?: string;
  strategy_reason?: string;
};
type Order = {
  id: string; symbol: string; strategy?: string; strategyName?: string; side: string; quantity: number; lotSize?: number; price: number; status: string; mode?: string;
  target?: number; stopLoss?: number; trailingStop?: number; trailingActivatedAt?: string; currentPrice?: number; pnl?: number; pnlPercent?: number; quoteSource?: string;
  createdAt: string; exitPrice?: number; exitReason?: string; realizedPnl?: number; realizedPnlPercent?: number; exitError?: string; reconcileWarning?: string;
};
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type QuoteUpdate = { symbol: string; price: number | null; timestamp: string; source: string };
type OptionCandidate = { symbol: string; contract: "CALL" | "PUT"; expiry: string; strike: number; premium: number; bid: number; ask: number; openInterest: number; volume: number; iv: number; delta: number; score: number; riskReward: number; lotSize?: number; tickSize?: number; freezeQuantity?: number };
type Contract = { symbol: string; growwSymbol: string; type: "CE" | "PE"; expiry?: string; strike?: number; lotSize: number; tickSize?: number; freezeQuantity?: number; active?: boolean };
type SearchResult = Contract & { exchange?: string };
type StrategyId = "ORB_RETEST" | "VWAP_REVERSAL" | "RANGE_DEFINED_RISK";
type LiveStatus = { enabled: boolean; disabledReasons: string[]; limits?: { maxDailyLoss: number; maxTradesPerDay: number; maxLotsPerOrder: number; maxOrderValue: number; maxOpenPositions: number; minRewardRisk: number }; today?: { tradesToday: number; realizedPnl: number; openRisk: number; lossBudgetLeft: number }; positions: Order[]; monitor?: { running: boolean; lastTickAt: string | null; lastError: string | null } };
type Tab = "LIVE" | "PAPER" | "HISTORY" | "LOGS";
type Log = { time: string; text: string; type: "entry" | "exit" | "info" };

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const TICKER = ["NIFTY", "BANKNIFTY", "SENSEX", "INDIA VIX"];
const FALLBACK_LOT: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 }; // used only if the contract master is unreachable
const STRATEGIES: Array<{ id: StrategyId; name: string; description: string }> = [
  { id: "ORB_RETEST", name: "ORB + Retest", description: "15-minute opening range breakout, retest hold within 3 candles, structural stop, 2R target." },
  { id: "VWAP_REVERSAL", name: "VWAP Reversal", description: "Rejection at support/resistance with a higher low / lower high, then a confirmed VWAP reclaim." },
  { id: "RANGE_DEFINED_RISK", name: "Range (analysis only)", description: "Defined-risk range regime detection. Multi-leg execution is not enabled; no naked selling." },
];
const money = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const calc = (value: unknown, percent = false) => formatMarketCalculationValue(value as number | string | null | undefined, { percent });
const norm = (value: string | undefined | null) => String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const istDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const nowLabel = () => new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

export default function ExecutionPage() {
  const [symbol, setSymbol] = useState<string>("NIFTY");
  const [strategyId, setStrategyId] = useState<StrategyId>("ORB_RETEST");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [paperOrders, setPaperOrders] = useState<Order[]>([]);
  const [history, setHistory] = useState<Order[]>([]);
  const [account, setAccount] = useState<{ available: number | null; source: string } | null>(null);
  const [safety, setSafety] = useState({ safeMode: false, killSwitch: false, reason: "" });
  const [message, setMessage] = useState("Paper mode is the default. Live orders need server enablement and a PIN-confirmed preview.");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("");
  const [quotes, setQuotes] = useState<Record<string, number>>({});
  const [streamStatus, setStreamStatus] = useState("connecting");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chain, setChain] = useState<OptionCandidate[]>([]);
  const [chainStatus, setChainStatus] = useState("Loading option chain…");
  const candlesRef = useRef<Candle[]>([]);
  const chainRef = useRef<OptionCandidate[]>([]);
  const mutationVersion = useRef(0);

  const [contract, setContract] = useState<Contract | null>(null);
  const [lots, setLots] = useState(1);
  const [stopLoss, setStopLoss] = useState("");
  const [target, setTarget] = useState("");
  const [ticketSource, setTicketSource] = useState("MANUAL");
  // ALGO_ORB orders are re-validated by the server's V5 pipeline; MANUAL orders are user-authorised.
  const [ticketOrigin, setTicketOrigin] = useState<"MANUAL" | "ALGO">("MANUAL");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [live, setLive] = useState<LiveStatus | null>(null);
  const [liveDraft, setLiveDraft] = useState<LiveTicketDraft | null>(null);
  const [livePin, setLivePin] = useState("");

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoMaxTrades, setAutoMaxTrades] = useState(3);
  const [autoMinLoss, setAutoMinLoss] = useState(2500);
  const [autoMinProfit, setAutoMinProfit] = useState(1000);
  const [autoStatus, setAutoStatus] = useState<{ tradesTaken: number; limitHit: boolean; summary: string; diagnostics?: string[] }>({ tradesTaken: 0, limitHit: false, summary: "Auto engine is off" });
  const autoBusy = useRef(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tab, setTab] = useState<Tab>("PAPER");
  const [logs, setLogs] = useState<Log[]>([]);
  const log = useCallback((text: string, type: Log["type"] = "info") => setLogs((current) => [{ time: nowLabel(), text, type }, ...current].slice(0, 200)), []);

  const strategy = STRATEGIES.find((item) => item.id === strategyId) ?? STRATEGIES[0];
  const lotSize = contract?.lotSize ?? FALLBACK_LOT[symbol] ?? 1;
  const spot = candles.at(-1)?.close ?? quotes[symbol] ?? 0;

  // ---- data loading -------------------------------------------------------------------
  const refresh = useCallback(async () => {
    setBusy(true);
    const version = mutationVersion.current;
    try {
      const data = await fetch(`/api/algo-trading?symbol=${symbol}&provider=groww&strategy=${strategyId}`, { cache: "no-store" }).then((response) => response.json());
      setAnalysis(data.analysis ?? null);
      setAccount(data.account ?? null);
      setSafety({ safeMode: Boolean(data.safeMode), killSwitch: Boolean(data.killSwitch), reason: data.killSwitchReason ?? data.safeModeReason ?? "" });
      if (version === mutationVersion.current) {
        setPaperOrders((data.orders ?? []).filter((order: Order) => order.mode !== "ALGO_LIVE"));
        setHistory(data.history ?? []);
      }
      if (data.error) setMessage(data.error);
    } catch { setMessage("Strategy engine unavailable; retrying on the next refresh."); }
    finally { setBusy(false); }
  }, [strategyId, symbol]);

  const refreshLive = useCallback(async () => {
    try { setLive(await fetch("/api/live-orders", { cache: "no-store" }).then((response) => response.json())); } catch { /* status is advisory */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void refreshLive();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refreshLive(); }, 10_000);
    return () => clearInterval(timer);
  }, [refreshLive]);
  useEffect(() => {
    const update = () => setClock(nowLabel());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  // One history request (cached server-side) + one chain request. The old page also called
  // /api/options-engine, which always failed on Groww chains (no bid/ask) before falling back.
  useEffect(() => {
    let cancelled = false;
    setChainStatus("Loading option chain…");
    Promise.all([
      fetch(`/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=5m&period=day&date=${istDate()}`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({})),
      fetch(`/api/option-chain?symbol=${symbol}`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({})),
    ]).then(([historyBody, chainBody]) => {
      if (cancelled) return;
      const nextCandles: Candle[] = Array.isArray(historyBody.candles) ? historyBody.candles : [];
      candlesRef.current = nextCandles;
      setCandles(nextCandles);
      const contracts: OptionCandidate[] = Array.isArray(chainBody.contracts) ? chainBody.contracts : [];
      chainRef.current = contracts;
      setChain(contracts);
      setChainStatus(contracts.length ? `Live ${symbol} chain · ${chainBody.expiry ?? ""}` : `Option chain unavailable${chainBody.error ? `: ${chainBody.error}` : ""}`);
    });
    return () => { cancelled = true; };
  }, [symbol]);

  // ---- auto engine (paper only) -------------------------------------------------------
  const runAutoScan = useCallback(async () => {
    const snapshot = candlesRef.current;
    const contracts = chainRef.current;
    if (autoBusy.current || !autoEnabled || snapshot.length < 3 || !contracts.length) return;
    if (analysis?.session && (!analysis.session.market_open || !analysis.session.entry_permitted)) { setAutoStatus((current) => ({ ...current, summary: "Waiting for the entry window (09:35-14:45 IST)" })); return; }
    autoBusy.current = true;
    try {
      const response = await fetch("/api/auto-option-trading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, maxTrades: autoMaxTrades, minimumLoss: autoMinLoss, minimumProfit: autoMinProfit, spot: snapshot.at(-1)?.close ?? 0, candles: snapshot.slice(-72).map((candle) => ({ ...candle, timestamp: new Date(candle.time * 1000).toISOString() })), contracts }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setAutoStatus((current) => ({ ...current, summary: data.error ?? "Auto scan blocked" })); return; }
      setAutoStatus({ tradesTaken: data.tradesTaken ?? 0, limitHit: Boolean(data.limitHit), summary: data.summary ?? "Scanned", diagnostics: data.diagnostics ?? [] });
      if (Array.isArray(data.orders) && data.orders.length) {
        const incoming = data.orders as Order[];
        setPaperOrders((current) => [...incoming.filter((order) => ["OPEN", "FILLED"].includes(order.status)), ...current.filter((order) => !incoming.some((next) => next.id === order.id))]);
        setHistory((current) => [...incoming, ...current.filter((order) => !incoming.some((next) => next.id === order.id))]);
      }
      log(`[Auto engine] ${data.summary ?? "Market scanned"}`, data.limitHit ? "info" : "entry");
    } catch { setAutoStatus((current) => ({ ...current, summary: "Auto scan unavailable; retrying" })); }
    finally { autoBusy.current = false; }
  }, [analysis?.session, autoEnabled, autoMaxTrades, autoMinLoss, autoMinProfit, log, symbol]);

  const scheduleAutoScan = useCallback(() => {
    if (!autoEnabled) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => { autoTimer.current = null; void runAutoScan(); }, 500);
  }, [autoEnabled, runAutoScan]);
  const scheduleRef = useRef(scheduleAutoScan);
  scheduleRef.current = scheduleAutoScan;
  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);

  // ---- live quotes: one socket per index, subscriptions updated in place ------------
  const subscription = useMemo(() => ({
    underlying: symbol,
    marketSymbols: TICKER,
    optionSymbols: Array.from(new Set(chain.map((item) => norm(item.symbol)))).sort(),
    tradeSymbols: Array.from(new Set(paperOrders.map((order) => norm(order.symbol)))).sort(),
  }), [chain, paperOrders, symbol]);
  const socketRef = useRef<WebSocket | null>(null);
  const subscriptionKey = JSON.stringify(subscription);
  useEffect(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(subscriptionKey);
  }, [subscriptionKey]);
  const subscriptionRef = useRef(subscriptionKey);
  subscriptionRef.current = subscriptionKey;

  // Server-side the socket shares one batched Groww poller across tabs and only pushes prices that
  // moved. The client reconnects with backoff and falls back to slow HTTP polling of the index
  // quotes while the socket server is unreachable, so the header never sits on "--".
  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const applyMarkets = (items: Array<{ symbol?: string; price?: number | null }>) => {
      const next: Record<string, number> = {};
      for (const item of items) if (item.symbol && typeof item.price === "number" && item.price > 0) next[item.symbol] = item.price;
      if (Object.keys(next).length) setQuotes((current) => ({ ...current, ...next }));
    };
    const pollHttp = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const data = await fetch(`/api/market-data?provider=groww&symbols=${encodeURIComponent(TICKER.join(","))}`, { cache: "no-store" }).then((response) => response.json());
        if (Array.isArray(data.quotes) && data.quotes.length) { applyMarkets(data.quotes); setStreamStatus("polling"); }
        else if (data.error) setStreamStatus(/429|rate/i.test(String(data.error)) ? "rate-limited" : "unavailable");
      } catch { /* keep the last prices */ }
    };
    const startPolling = () => {
      if (pollTimer) return;
      void pollHttp();
      pollTimer = setInterval(() => { void pollHttp(); }, 10_000);
    };
    const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };

    const onTick = (price: number) => {
      const bucket = Math.floor(Date.now() / 300_000) * 300;
      const current = candlesRef.current;
      const last = current.at(-1);
      const next = !last ? [{ time: bucket, open: price, high: price, low: price, close: price, volume: 0 }]
        : last.time >= bucket ? [...current.slice(0, -1), { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }]
          : [...current.slice(-150), { time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 }];
      candlesRef.current = next;
      setCandles(next);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      setStreamStatus(attempts ? "reconnecting" : "connecting");
      socket = new WebSocket(process.env.NEXT_PUBLIC_API_WS_URL ?? `${protocol}://${window.location.hostname}:4000/ws/quotes`);
      socketRef.current = socket;
      socket.onopen = () => { attempts = 0; socket?.send(subscriptionRef.current); };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        setStreamStatus("unavailable");
        startPolling();
        attempts += 1;
        retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
      };
      socket.onmessage = (event) => {
        let payload: { type?: string; state?: string; quote?: QuoteUpdate; quotes?: QuoteUpdate[] };
        try { payload = JSON.parse(event.data); } catch { return; }
        if (payload.type === "status" && payload.state) {
          setStreamStatus(payload.state);
          if (payload.state === "live") stopPolling();
          return;
        }
        if (payload.type === "markets" && Array.isArray(payload.quotes)) {
          stopPolling();
          setStreamStatus("live");
          applyMarkets(payload.quotes);
          return;
        }
        if (payload.type === "market" && payload.quote?.price) {
          const price = payload.quote.price;
          setQuotes((current) => ({ ...current, [payload.quote!.symbol || symbol]: price }));
          onTick(price);
          scheduleRef.current();
          return;
        }
        const updates = payload.quotes;
        if ((payload.type === "chain" || payload.type === "quotes") && updates?.length) {
          const prices = new Map<string, number>();
          for (const quote of updates) if (quote.price && quote.price > 0) prices.set(norm(quote.symbol), quote.price);
          if (!prices.size) return;
          if (payload.type === "chain") {
            let touched = false;
            const nextChain = chainRef.current.map((item) => { const price = prices.get(norm(item.symbol)); if (!price || price === item.premium) return item; touched = true; return { ...item, premium: price, bid: price, ask: price }; });
            if (touched) { chainRef.current = nextChain; setChain(nextChain); }
          } else {
            setPaperOrders((current) => current.map((order) => {
              const price = prices.get(norm(order.symbol));
              if (!price || price === order.currentPrice) return order;
              const pnl = (price - order.price) * order.quantity;
              return { ...order, currentPrice: price, pnl, pnlPercent: order.price ? (price - order.price) / order.price * 100 : 0, quoteSource: "Groww live" };
            }));
          }
          scheduleRef.current();
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
      socket?.close();
      socketRef.current = null;
    };
  }, [symbol]);

  // ---- paper orders -------------------------------------------------------------------
  const exitPaper = useCallback(async (order: Order) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/algo-trading?id=${encodeURIComponent(order.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage(data.error ?? "Paper exit failed"); return; }
      mutationVersion.current += 1;
      setPaperOrders((current) => current.filter((item) => item.id !== order.id));
      if (data.order) setHistory((current) => [data.order as Order, ...current.filter((item) => item.id !== order.id)]);
      log(`Paper exit ${order.symbol} · P&L ₹${money(data.order?.realizedPnl ?? order.pnl ?? 0)}`, "exit");
    } catch { setMessage("Paper exit request failed"); }
    finally { setBusy(false); }
  }, [log]);

  // Paper stop/target automation (never touches live positions; those exit server-side).
  useEffect(() => {
    const pending = paperOrders.find((order) => {
      if (order.mode === "ALGO_LIVE" || !["OPEN", "FILLED"].includes(order.status) || !order.stopLoss) return false;
      const premium = chain.find((item) => norm(item.symbol) === norm(order.symbol))?.premium ?? Number(order.currentPrice ?? order.price);
      const state = getOrderExitState(order, premium);
      return state.hitStop || state.hitTarget;
    });
    if (pending) void exitPaper(pending);
  }, [chain, paperOrders, exitPaper]);

  const premiumFor = (value: Contract | null) => chain.find((item) => norm(item.symbol) === norm(value?.symbol))?.premium;

  async function withMetadata(value: Contract): Promise<Contract> {
    if (value.tickSize && value.freezeQuantity && value.active !== undefined) return value;
    try {
      const data = await fetch(`/api/groww-instruments?q=${encodeURIComponent(value.symbol)}`, { cache: "no-store" }).then((response) => response.json());
      const exact = (data.instruments ?? []).find((item: SearchResult) => item.symbol === value.symbol);
      return exact ? { ...value, ...exact } : value;
    } catch { return value; }
  }

  function validTicket(): string | null {
    if (!contract) return "Select a contract first (search below, or load the trade-desk plan).";
    const sl = Number(stopLoss);
    const tp = Number(target);
    if (!(sl > 0) || !(tp > 0)) return "Enter the stop-loss and target premiums.";
    if (!(lots >= 1)) return "Lots must be at least 1.";
    return null;
  }

  async function placePaper() {
    const problem = validTicket();
    if (problem) { setMessage(problem); return; }
    if (strategyId === "RANGE_DEFINED_RISK") { setMessage("Range strategy is analysis-only; no naked option selling is permitted."); return; }
    const enriched = await withMetadata(contract!);
    setContract(enriched);
    const premium = premiumFor(enriched);
    if (!premium) { setMessage("No live premium for this contract yet; wait for the chain to load or pick a near-ATM strike."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/algo-trading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        mode: "PAPER", orderSource: ticketOrigin, strategy: strategyId, strategyName: `${strategy.name}${ticketSource !== "MANUAL" ? ` · ${ticketSource}` : ""}`, underlying: symbol,
        symbol: enriched.symbol, growwSymbol: enriched.growwSymbol, side: "BUY", quantity: lots * enriched.lotSize, lotSize: enriched.lotSize, price: premium,
        target: Number(target), stopLoss: Number(stopLoss), expiry: enriched.expiry, optionType: enriched.type, strike: enriched.strike,
        tickSize: enriched.tickSize, freezeQuantity: enriched.freezeQuantity, contractActive: enriched.active, analysisDecision: analysis?.decision,
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.order) { setMessage(data.error ?? "Paper order rejected"); return; }
      mutationVersion.current += 1;
      setPaperOrders((current) => [data.order as Order, ...current]);
      setHistory((current) => [data.order as Order, ...current.filter((item) => item.id !== data.order.id)]);
      setTab("PAPER");
      setMessage(`Paper order placed: ${data.order.symbol} × ${data.order.quantity} @ ₹${data.order.price}`);
      log(`Paper entry ${data.order.symbol} × ${data.order.quantity} @ ₹${data.order.price}`, "entry");
    } catch { setMessage("Paper order request failed"); }
    finally { setBusy(false); }
  }

  function openLive() {
    const problem = validTicket();
    if (problem) { setMessage(problem); return; }
    if (!live?.enabled) { setMessage(`Live trading is disabled: ${(live?.disabledReasons ?? ["status unavailable"]).join("; ")}`); return; }
    setLiveDraft({ symbol: contract!.symbol, lots, stopLoss: Number(stopLoss), target: Number(target), source: ticketSource });
  }

  async function liveAction(action: "exit" | "mark_closed", order: Order) {
    const exitPrice = action === "mark_closed" ? Number(window.prompt(`Exit price you received in the Groww app for ${order.symbol}?`) ?? "") : undefined;
    if (action === "mark_closed" && !(Number(exitPrice) > 0)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/live-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, orderId: order.id, pin: livePin, exitPrice }) });
      const data = await response.json().catch(() => ({}));
      setMessage(response.ok ? `Live ${order.symbol} ${action === "exit" ? "exited" : "marked closed"}${data.order?.realizedPnl !== undefined ? ` · P&L ₹${money(data.order.realizedPnl)}` : ""}` : data.error ?? "Live action failed");
      if (response.ok) log(`LIVE ${action} ${order.symbol}`, "exit");
      await refreshLive();
    } finally { setBusy(false); }
  }

  async function search() {
    const value = query.trim().toUpperCase();
    if (value.length < 2) return;
    setSearching(true);
    try {
      const data = await fetch(`/api/groww-instruments?q=${encodeURIComponent(value)}`, { cache: "no-store" }).then((response) => response.json());
      setResults(Array.isArray(data.instruments) ? data.instruments.slice(0, 8) : []);
    } catch { setResults([]); }
    finally { setSearching(false); }
  }

  const loadPlan = useCallback((plan: TradePlan, context: { symbol: string; expiry: string | null; lotSize: number | null }) => {
    if (!plan.contract || !plan.premium) return;
    const size = context.lotSize && context.lotSize > 0 ? context.lotSize : FALLBACK_LOT[context.symbol] ?? 1;
    setContract({ symbol: plan.contract.trading_symbol, growwSymbol: plan.contract.trading_symbol, type: plan.contract.side, expiry: context.expiry ?? undefined, strike: plan.contract.strike, lotSize: size });
    setLots(Math.max(1, plan.lots ?? 1));
    setStopLoss(String(plan.premium.stop));
    setTarget(String(plan.premium.target1));
    setTicketSource(`Desk ${plan.status}`);
    setTicketOrigin("MANUAL");
    setMessage(`Plan loaded: BUY ${plan.contract.trading_symbol} · SL ₹${plan.premium.stop} · T1 ₹${plan.premium.target1}. Status ${plan.status}${plan.status === "READY" ? "" : " (practise in paper mode)"}.`);
    document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const [cacheClearing, setCacheClearing] = useState(false);
  const clearCache = useCallback(async () => {
    setCacheClearing(true);
    try {
      await fetch("/api/cache", { method: "POST", cache: "no-store" });
      setMessage("Server caches cleared (contract master, history, trade desk, sentiment). Reloading…");
      await refresh();
    } catch { setMessage("Cache clear failed; live data was not changed."); }
    finally { setCacheClearing(false); }
  }, [refresh]);
  const aiContext = useCallback(() => ({
    symbol, timeframe: "5m", executionMode: live?.enabled ? "ALGO_LIVE_ARMED" : "PAPER", marketStatus: sessionLabelRef.current, deterministicAnalysis: analysis,
    candles: candlesRef.current.slice(-30), optionCandidates: chainRef.current.slice(0, 20), risk: { safeMode: safety.safeMode, killSwitch: safety.killSwitch, autoTradeEnabled: autoEnabled },
  }), [analysis, autoEnabled, live?.enabled, safety.killSwitch, safety.safeMode, symbol]);
  const sessionLabelRef = useRef("--");

  // Map a confirmed V5 spot setup onto a liquid option: CE for BUY, PE for SELL, delta closest
  // to 0.55 (ATM / slightly ITM), premium levels by delta, 25% premium circuit breaker (spec 15).
  const loadStrategySetup = useCallback(() => {
    const setup = analysis?.setup;
    if (!setup || analysis?.pipeline?.decision !== "CONFIRMED") return;
    const wanted = setup.side === "SELL" ? "PUT" : "CALL";
    const pick = chainRef.current
      .filter((item) => item.contract === wanted && item.premium > 0)
      .sort((left, right) => Math.abs(Math.abs(left.delta || 0.5) - 0.55) - Math.abs(Math.abs(right.delta || 0.5) - 0.55) || Math.abs(left.strike - setup.entry) - Math.abs(right.strike - setup.entry))[0];
    if (!pick) { setMessage(`No live ${wanted === "CALL" ? "CE" : "PE"} premium in the chain yet; wait for the option chain to load.`); return; }
    const delta = Math.abs(pick.delta) > 0.05 ? Math.abs(pick.delta) : 0.5;
    const premiumStop = Math.max(pick.premium - delta * Math.abs(setup.entry - setup.stop_loss), pick.premium * 0.75);
    const premiumTarget = pick.premium + delta * Math.abs(setup.target - setup.entry);
    const round = (value: number) => Math.round(value * 20) / 20;
    setContract({ symbol: pick.symbol, growwSymbol: pick.symbol, type: wanted === "CALL" ? "CE" : "PE", expiry: pick.expiry, strike: pick.strike, lotSize: pick.lotSize && pick.lotSize > 0 ? pick.lotSize : FALLBACK_LOT[symbol] ?? 1, tickSize: pick.tickSize, freezeQuantity: pick.freezeQuantity });
    setLots(1);
    setStopLoss(String(round(premiumStop)));
    setTarget(String(round(premiumTarget)));
    setTicketSource(`${strategy.name} V5`);
    setTicketOrigin("ALGO");
    setMessage(`${strategy.name} setup loaded: BUY ${pick.symbol} (delta ${delta.toFixed(2)}) · SL ₹${round(premiumStop)} · target ₹${round(premiumTarget)}${setup.gap_day ? " · gap day: half size, keep 1 lot" : ""}. The server re-checks every V5 gate when you place it.`);
    document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [analysis, strategy.name, symbol]);

  const switchIndex = useCallback((next: string) => { setSymbol(next); setContract(null); setResults([]); setQuery(""); }, []);

  // ---- derived ---------------------------------------------------------------------------
  const openPaper = useMemo(() => paperOrders.filter((order) => ["OPEN", "FILLED"].includes(order.status)), [paperOrders]);
  const paperPnl = openPaper.reduce((sum, order) => sum + (order.pnl ?? 0), 0);
  const livePositions = live?.positions ?? [];
  const livePnl = livePositions.reduce((sum, order) => sum + (order.pnl ?? 0), 0);
  const sessionLabel: string = !analysis?.session ? "--" : !analysis.session.market_open ? "MARKET CLOSED" : analysis.session.entry_permitted ? "ENTRY WINDOW" : analysis.session.window.replaceAll("_", " ");
  sessionLabelRef.current = sessionLabel;
  const score = analysis?.calculations?.score ?? {};
  const orb = analysis?.calculations?.orb;
  const underlying = analysis?.calculations?.underlying ?? {};
  const ticketPremium = premiumFor(contract);
  const ticketRisk = ticketPremium && Number(stopLoss) > 0 ? (ticketPremium - Number(stopLoss)) * lots * lotSize : null;
  const ticketReward = ticketPremium && Number(target) > 0 ? (Number(target) - ticketPremium) * lots * lotSize : null;

  return (
    <main className="exec-page">
      <header className="exec-header">
        <div className="exec-brand"><b>TradePulse</b><small>Index options desk</small></div>
        <div className="algo-ticker" aria-label="Live index quotes">{TICKER.map((item) => <span key={item}><b>{item}</b><small>{quotes[item] ? money(quotes[item]) : "--"}</small></span>)}</div>
        <div className="exec-badges">
          <span className={live?.enabled ? "exec-badge exec-badge-live" : "exec-badge"} title={live?.enabled ? "Live trading armed on the server" : (live?.disabledReasons ?? []).join("\n")}>{live?.enabled ? "LIVE ARMED" : "PAPER ONLY"}</span>
          {safety.killSwitch && <span className="exec-badge exec-badge-danger" title={safety.reason}>KILL SWITCH</span>}
          {safety.safeMode && <span className="exec-badge exec-badge-danger" title={safety.reason}>SAFE MODE</span>}
          <span className="exec-badge">{sessionLabel}</span>
          <span className="exec-badge">IST {clock || "--:--:--"}</span>
          <span className={streamStatus === "live" ? "exec-badge gain" : "exec-badge warning"}>Quotes {streamStatus}</span>
          <button type="button" className="exec-badge exec-badge-button" onClick={() => void clearCache()} disabled={cacheClearing}>{cacheClearing ? "Clearing…" : "Clear cache"}</button>
          <span className="exec-badge">Margin {account?.available !== null && account?.available !== undefined ? `₹${money(account.available)}` : "--"}</span>
        </div>
      </header>

      <div className="exec-content">
        <p className="exec-message" role="status">{message}</p>
        <MarketIntelPanel symbol={symbol} onSymbolChange={switchIndex} onUsePlan={loadPlan} />
        <SentimentPanel />
        <AIMonitoringPanel symbol={symbol} strategyId={strategyId} buildContext={aiContext} />

        <div className="exec-grid">
          <article className="mi-card exec-strategy">
            <div className="algo-panel-head">
              <div><span className="algo-kicker">V5 RULE ENGINE · {symbol}</span><h2>{strategy.name}: <span className={analysis?.pipeline?.decision === "CONFIRMED" ? "gain" : "warning"}>{analysis?.pipeline?.decision ?? analysis?.decision ?? "WAITING"}</span></h2></div>
              <div className="exec-strategy-controls">
                <select aria-label="Strategy" value={strategyId} onChange={(event) => setStrategyId(event.target.value as StrategyId)}>{STRATEGIES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                <button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? "…" : "Refresh"}</button>
              </div>
            </div>
            <p className="mi-note">{strategy.description}</p>
            {analysis?.setup ? (
              <div className="exec-setup"><b className={analysis.setup.side === "SELL" ? "loss" : "gain"}>{analysis.setup.side === "SELL" ? "BEARISH → buy PE" : "BULLISH → buy CE"}</b><span>Spot entry {money(analysis.setup.entry)} · SL {money(analysis.setup.stop_loss)} · target {money(analysis.setup.target)} · {analysis.setup.risk_reward ?? 2}R</span></div>
            ) : null}
            {analysis?.setup && analysis.pipeline?.decision === "CONFIRMED" && <button type="button" className="mi-use-plan" onClick={loadStrategySetup}>Load {strategy.name} setup into the order ticket</button>}
            {strategyId === "ORB_RETEST" && orb && (
              <div className="exec-orb" aria-label="ORB timeline">
                <span>OR ({String(orb.opening_minutes ?? 15)}m{analysis?.calculations?.gap?.status && analysis.calculations.gap.status !== "NORMAL_DAY" ? ", gap day" : ""}) <b>{calc(orb.opening_range_high)} / {calc(orb.opening_range_low)}</b></span>
                <span>Breakout <b>{orb.breakout_time ? String(orb.breakout_time).slice(11, 16) : "--"}</b></span>
                <span>Retest <b>{orb.retest_time ? String(orb.retest_time).slice(11, 16) : "--"}</b></span>
                <span>Status <b className={orb.status === "CONFIRMED" ? "gain" : "warning"}>{String(orb.status ?? "--").replaceAll("_", " ")}</b></span>
                <small>{String(analysis?.strategy_reason ?? orb.reason ?? "")}</small>
              </div>
            )}
            {!analysis?.setup && <p className="mi-note">{analysis?.pipeline ? `${analysis.pipeline.gates.filter((gate) => gate.passed).length}/${analysis.pipeline.gates.length} gates passing. No setup until every gate is green.` : analysis?.reason ?? "Waiting for the engine…"}</p>}
            <div className="exec-score">
              {[["Trend cluster", score.trend_cluster, 3], ["Structure", score.structure_cluster, 3], ["Volume", score.volume_evidence, 2], ["Option strength", score.option_relative_strength, 1], ["OI writers", score.oi_direction, 1]].map(([name, value, max]) => (
                <span key={String(name)}><small>{name}</small><b>{calc(value)} / {String(max)}</b></span>
              ))}
              <span className="exec-score-total"><small>Total</small><b className={Number(score.total) >= Number(score.minimum ?? 8) ? "gain" : "warning"}>{calc(score.total)} / 10</b><em>min {calc(score.minimum ?? 8)}</em></span>
            </div>
            <div className="exec-gates">{(analysis?.pipeline?.gates ?? []).map((gate) => <span key={gate.code} className={gate.passed ? "pass" : "fail"} title={gate.detail}>{gate.passed ? "✓" : "✗"} {gate.code.replace(/_(BLOCKED|NOT_CONFIRMED|NOT_SUPPORTIVE|BELOW_MINIMUM|UNRESOLVED|MISSING|REQUIRED|UNHEALTHY|STALE|INVALID|NOT_READY)$/, "").replaceAll("_", " ").toLowerCase()}</span>)}</div>
            <details className="mi-management">
              <summary>Show calculations</summary>
              <div className="exec-calcs">
                <span>VWAP <b>{calc(underlying.vwap)}</b></span><span>EMA 20/50 <b>{calc(underlying.ema20)} / {calc(underlying.ema50)}</b></span><span>ADX <b>{calc(underlying.adx14)}</b></span><span>ATR <b>{calc(underlying.atr14)}</b></span>
                <span>OR high/low <b>{calc(analysis?.calculations?.orb?.opening_range_high)} / {calc(analysis?.calculations?.orb?.opening_range_low)}</b></span><span>ORB status <b>{calc(analysis?.calculations?.orb?.status)}</b></span>
                <span>Regime <b>{analysis?.calculations?.regime ?? "--"}</b></span><span>Gap day <b>{calc(analysis?.calculations?.gap?.status)}</b></span><span>VIX regime <b>{calc(analysis?.calculations?.option?.iv_regime)}</b></span>
              </div>
            </details>
          </article>

          <article className="mi-card exec-ticket" id="order-ticket">
            <div className="algo-panel-head"><div><span className="algo-kicker">ORDER TICKET · OPTION BUY</span><h2>{contract ? contract.symbol : "No contract selected"}</h2></div><span>{chainStatus}</span></div>
            <div className="exec-search">
              <input aria-label="Search option contract" value={query} onChange={(event) => setQuery(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={`e.g. ${symbol} 25000 CE`} />
              <button type="button" onClick={() => void search()} disabled={searching}>{searching ? "…" : "Search"}</button>
            </div>
            {results.length > 0 && <div className="exec-results">{results.map((item) => <button type="button" key={item.growwSymbol} onClick={() => { setContract({ ...item, lotSize: item.lotSize || FALLBACK_LOT[symbol] || 1 }); setResults([]); setTicketSource("MANUAL"); setTicketOrigin("MANUAL"); }}>{item.symbol}<small>{item.type} · {item.expiry} · lot {item.lotSize}</small></button>)}</div>}
            {contract && <p className="mi-note">{contract.type} · strike {money(contract.strike)} · expiry {contract.expiry ?? "--"} · lot {lotSize} · premium {ticketPremium ? `₹${money(ticketPremium)}` : "awaiting quote"}</p>}
            <div className="exec-fields">
              <label>Lots<input type="number" min={1} step={1} value={lots} onChange={(event) => setLots(Math.max(1, Math.floor(Number(event.target.value) || 1)))} /><small>{lots * lotSize} qty</small></label>
              <label>Stop-loss (premium ₹)<input type="number" min={0} step={0.05} value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} /></label>
              <label>Target (premium ₹)<input type="number" min={0} step={0.05} value={target} onChange={(event) => setTarget(event.target.value)} /></label>
            </div>
            <div className="mi-risk-row"><span>Risk <b className="loss">{ticketRisk !== null ? `₹${money(ticketRisk)}` : "--"}</b></span><span>Reward <b className="gain">{ticketReward !== null ? `₹${money(ticketReward)}` : "--"}</b></span><span>R:R <b>{ticketRisk && ticketReward ? (ticketReward / ticketRisk).toFixed(2) : "--"}</b></span></div>
            <div className="exec-actions">
              <button type="button" className="exec-paper" onClick={() => void placePaper()} disabled={busy}>Paper order</button>
              <button type="button" className="exec-live" onClick={openLive} disabled={busy || !live?.enabled} title={live?.enabled ? "Preview and confirm a real Groww order" : (live?.disabledReasons ?? []).join("\n")}>Live order · real money</button>
            </div>
            {!live?.enabled && <small className="mi-note">Live is off: {(live?.disabledReasons ?? ["status unavailable"]).slice(0, 3).join("; ")}.</small>}
          </article>
        </div>

        <article className="mi-card exec-auto">
          <div className="algo-panel-head">
            <div><span className="algo-kicker">AUTO OPTION ENGINE · PAPER ONLY</span><h2>{autoEnabled ? `${autoStatus.tradesTaken}/${autoMaxTrades} trades · ${autoStatus.limitHit ? "suggest-only" : "tracking"}` : "Off"}</h2></div>
            <label className="auto-trade-toggle"><input type="checkbox" checked={autoEnabled} onChange={(event) => { setAutoEnabled(event.target.checked); setAutoStatus((current) => ({ ...current, summary: event.target.checked ? "Starting market scan" : "Auto engine is off" })); }} /> Enable</label>
          </div>
          <div className="exec-fields">
            <label>Max trades<select value={autoMaxTrades} onChange={(event) => setAutoMaxTrades(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Max loss per trade<select value={autoMinLoss} onChange={(event) => setAutoMinLoss(Number(event.target.value))}>{[500, 1000, 1500, 2000, 2500, 5000].map((value) => <option key={value} value={value}>₹{value.toLocaleString("en-IN")}</option>)}</select></label>
            <label>Trail after profit<select value={autoMinProfit} onChange={(event) => setAutoMinProfit(Number(event.target.value))}>{[0, 500, 1000, 1500, 2500].map((value) => <option key={value} value={value}>{value ? `₹${value.toLocaleString("en-IN")}` : "at +1R"}</option>)}</select></label>
          </div>
          <p className="mi-note">{autoStatus.summary}. Entries require the trade-desk verdict to agree and pause in extreme VIX or sideways markets; the auto engine never sends real orders.</p>
          {autoStatus.diagnostics?.length ? <details className="mi-management"><summary>Why no trade?</summary><ul>{autoStatus.diagnostics.slice(0, 6).map((item) => <li key={item}><small>{item}</small></li>)}</ul></details> : null}
        </article>

        <article className="mi-card exec-orders">
          <div className="exec-tabs" role="tablist">
            {([["LIVE", `Live positions (${livePositions.length})`], ["PAPER", `Paper positions (${openPaper.length})`], ["HISTORY", `History (${history.length})`], ["LOGS", `Logs (${logs.length})`]] as Array<[Tab, string]>).map(([key, text]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{text}</button>)}
            <strong className={(tab === "LIVE" ? livePnl : paperPnl) >= 0 ? "gain" : "loss"}>Unrealised {tab === "LIVE" ? "live" : "paper"} ₹{money(tab === "LIVE" ? livePnl : paperPnl)}</strong>
          </div>

          {tab === "LIVE" && (
            <>
              {live?.today && <div className="mi-risk-row"><span>Trades today <b>{live.today.tradesToday}/{live.limits?.maxTradesPerDay}</b></span><span>Realised <b className={live.today.realizedPnl >= 0 ? "gain" : "loss"}>₹{money(live.today.realizedPnl)}</b></span><span>Open risk <b>₹{money(live.today.openRisk)}</b></span><span>Loss budget left <b>₹{money(live.today.lossBudgetLeft)}</b></span><span>Monitor <b className={live.monitor?.running ? "gain" : ""}>{live.monitor?.running ? "running" : "idle"}</b></span></div>}
              {live?.monitor?.lastError && <p className="loss mi-note">Monitor error: {live.monitor.lastError}</p>}
              {livePositions.length ? (
                <>
                  <label className="exec-pin">Trading PIN for manual actions<input type="password" inputMode="numeric" autoComplete="off" value={livePin} onChange={(event) => setLivePin(event.target.value)} /></label>
                  <table className="exec-table"><thead><tr><th>Contract</th><th>Qty</th><th>Entry</th><th>LTP</th><th>Stop</th><th>Target</th><th>P&amp;L</th><th /></tr></thead><tbody>
                    {livePositions.map((order) => <tr key={order.id}>
                      <td><b>{order.symbol}</b>{order.reconcileWarning && <small className="warning"> ⚠ {order.reconcileWarning}</small>}{order.exitError && <small className="loss"> {order.exitError}</small>}</td>
                      <td>{order.quantity}</td><td>₹{money(order.price)}</td><td>₹{money(order.currentPrice)}</td>
                      <td>₹{money(order.stopLoss)}{order.trailingActivatedAt ? <small> trailing</small> : null}</td><td>₹{money(order.target)}</td>
                      <td className={(order.pnl ?? 0) >= 0 ? "gain" : "loss"}>₹{money(order.pnl)}</td>
                      <td><button type="button" className="algo-exit" disabled={busy || livePin.length < 6} onClick={() => void liveAction("exit", order)}>Exit now</button>{order.reconcileWarning && <button type="button" className="algo-exit" disabled={busy || livePin.length < 6} onClick={() => void liveAction("mark_closed", order)}>Mark closed</button>}</td>
                    </tr>)}
                  </tbody></table>
                </>
              ) : <div className="algo-empty">No open live positions.</div>}
            </>
          )}

          {tab === "PAPER" && (openPaper.length ? (
            <table className="exec-table"><thead><tr><th>Contract</th><th>Strategy</th><th>Qty</th><th>Entry</th><th>LTP</th><th>SL / Target</th><th>P&amp;L</th><th /></tr></thead><tbody>
              {openPaper.map((order) => <tr key={order.id}>
                <td><b>{order.symbol}</b></td><td><small>{order.strategyName ?? order.strategy}</small></td><td>{order.quantity}</td><td>₹{money(order.price)}</td><td>₹{money(order.currentPrice ?? order.price)}</td>
                <td>₹{money(order.stopLoss)} / ₹{money(order.target)}{order.trailingActivatedAt ? <small> trail ₹{money(order.trailingStop)}</small> : null}</td>
                <td className={(order.pnl ?? 0) >= 0 ? "gain" : "loss"}>{order.pnl !== undefined ? `₹${money(order.pnl)}` : "awaiting quote"}</td>
                <td><button type="button" className="algo-exit" onClick={() => void exitPaper(order)} disabled={busy}>Exit</button></td>
              </tr>)}
            </tbody></table>
          ) : <div className="algo-empty">No open paper positions.</div>)}

          {tab === "HISTORY" && (history.length ? (
            <table className="exec-table"><thead><tr><th>Time</th><th>Mode</th><th>Contract</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Realised</th><th>Status</th></tr></thead><tbody>
              {history.slice(0, 60).map((item) => <tr key={item.id}>
                <td><small>{new Date(item.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</small></td>
                <td><span className={item.mode === "ALGO_LIVE" ? "exec-badge exec-badge-live" : "exec-badge"}>{item.mode === "ALGO_LIVE" ? "LIVE" : "PAPER"}</span></td>
                <td><b>{item.symbol}</b></td><td>{item.quantity}</td><td>₹{money(item.price)}</td><td>{item.exitPrice ? `₹${money(item.exitPrice)}` : "--"}</td><td><small>{item.exitReason ?? "--"}</small></td>
                <td className={(item.realizedPnl ?? 0) >= 0 ? "gain" : "loss"}>{item.realizedPnl !== undefined ? `₹${money(item.realizedPnl)}` : "--"}</td><td><small>{item.status}</small></td>
              </tr>)}
            </tbody></table>
          ) : <div className="algo-empty">No trades recorded yet.</div>)}

          {tab === "LOGS" && (logs.length ? <div className="algo-logs-list">{logs.map((entry, index) => <div className={`algo-log-entry ${entry.type}`} key={`${entry.time}-${index}`}><span className="algo-log-time">{entry.time}</span><span>{entry.text}</span></div>)}</div> : <div className="algo-empty">No activity yet this session.</div>)}
        </article>
        <p className="mi-disclaimer">Options trading involves substantial risk. This software is not investment advice and is not a SEBI-registered adviser. API trading may require static-IP registration and algo approval with your broker under SEBI&apos;s retail algo framework; confirm with Groww before enabling live mode.</p>
      </div>
      {liveDraft && <LiveOrderDialog draft={liveDraft} onClose={() => setLiveDraft(null)} onPlaced={(text) => { setMessage(text); log(text, "entry"); setTab("LIVE"); void refreshLive(); }} />}
    </main>
  );
}
