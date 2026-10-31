"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchJsonShared } from "../../lib/shared-fetch";
import { formatMarketCalculationValue, getOrderExitState } from "../../lib/option-chain-state";
import type { TradePlan } from "../../components/market-intel/market-intel-panel";
import type { NextDaySetup } from "../../components/execution/next-day-panel";
import type { ChartBar, ChartLevel, RiskRewardBox } from "../../components/scalper/premium-chart";
import type { VwapScalpSignal } from "../../components/scalper/scalper-desk";
import type { LiveTicketDraft } from "../../components/live/live-order-dialog";
import type { OptionAdvice } from "../../../../services/ai-monitoring/src/option-advisor";

// Heavy, below-the-fold or on-demand panels load in their own chunks so the first paint only
// needs the header and the trade desk shell. Every panel is memoised, so a quote tick re-renders
// only the parts that read the moved price.
const MarketIntelPanel = dynamic(() => import("../../components/market-intel/market-intel-panel").then((module) => module.MarketIntelPanel), { ssr: false, loading: () => <div className="algo-empty">Loading trade desk…</div> });
const OptionStrategyPanel = dynamic(() => import("../../components/market-intel/option-strategy-panel").then((module) => module.OptionStrategyPanel), { ssr: false });
const AIMonitoringPanel = dynamic(() => import("../../components/ai/ai-monitoring-panel").then((module) => module.AIMonitoringPanel), { ssr: false });
const LiveOrderDialog = dynamic(() => import("../../components/live/live-order-dialog").then((module) => module.LiveOrderDialog), { ssr: false });
const NextDayPanel = dynamic(() => import("../../components/execution/next-day-panel").then((module) => module.NextDayPanel), { ssr: false });
const ScalperDesk = dynamic(() => import("../../components/scalper/scalper-desk").then((module) => module.ScalperDesk), { ssr: false, loading: () => <div className="algo-empty">Loading scalper…</div> });
const PremiumChart = dynamic(() => import("../../components/scalper/premium-chart").then((module) => module.PremiumChart), { ssr: false });

type PipelineGate = { code: string; passed: boolean; detail: string };
type ScalpContract = { symbol: string; type: "CE" | "PE"; strike: number; expiry?: string | null; lot_size?: number | null; tick_size?: number | null; freeze_quantity?: number | null };
type ScalpCriterion = { key: string; name: string; points: number; max: number; passed: boolean; detail: string };
type ScalpCandidate = { symbol: string; strike: number; type: "CE" | "PE"; premium: number; delta: number; iv?: number | null; open_interest: number; volume: number; oi_change_5m?: number | null; activity?: string | null; spread_pct?: number | null; liquidity_score: number; selection_score: number };
type ScalpPlan = {
  valid: boolean; reason: string; spot_entry?: number; spot_stop?: number; spot_target?: number; risk_points?: number; target_points?: number; rr_choice?: number;
  entry?: number; stop_loss?: number; target?: number; lot_size?: number; lots?: number; quantity?: number; risk_reward?: number; net_risk_reward?: number; cost_share?: number;
  greeks?: { delta: number; gamma: number; theta_per_day: number; iv: number | null }; theta_drag?: number; premium_loss_delta_only?: number; premium_gain_delta_only?: number;
  gamma_effect?: { on_loss: number; on_gain: number }; costs_per_lot?: { at_target: number; at_stop: number }; risk_per_lot?: number; reward_per_lot?: number; max_loss?: number;
  planned_max_loss?: number; stressed_risk_reward?: number; stop_gap?: number; slippage_pct?: number; max_entry?: number; fill_tolerance?: number;
};
type ScalpCalc = {
  rr_choice: "1:1" | "1:2";
  tape: { side?: "CE" | "PE" | null; close?: number; vwap?: number; ema5?: number; ema9?: number; atr?: number; vwap_slope?: number; vwap_extension_atr?: number; volume_ratio?: number | null; risk_points?: number; reason?: string };
  trigger?: { time: string; close: number } | null;
  criteria: ScalpCriterion[];
  candidates: ScalpCandidate[];
  selected: ScalpCandidate | null;
  plan: ScalpPlan | null;
  profile: { poc: number; vah: number; val: number; close?: number; volume_ratio?: number | null } | null;
  oi?: { atm_strike?: number; wall?: number | null; room_points?: number | null; oi_direction_score?: number | null; atm_activity?: { CE?: string | null; PE?: string | null } };
  pcr?: { pcr: number | null; pcr_change_5m: number | null };
  vix?: { value: number | null; regime: string | null };
  score?: { total: number; minimum: number; maximum: number };
};
type StrategySetup = { side: string; entry: number; stop_loss: number; target: number; risk_reward?: number; net_risk_reward?: number; planned_max_loss?: number; max_entry?: number; stressed_risk_reward?: number; rr_choice?: string; lots?: number; quantity?: number; max_loss?: number; setup_id?: string; trigger_time?: string | null; target_method?: string; stop_method?: string; size_multiplier?: number; gap_day?: boolean; instrument?: "OPTION_PREMIUM"; contract?: ScalpContract; spot?: { entry: number; stop: number; target: number } };
type Analysis = {
  decision: string; reason?: string;
  setup?: StrategySetup;
  calculations?: { underlying?: Record<string, number | string | null>; gap?: Record<string, number | string | null>; score?: Record<string, number | string | boolean | null>; risk?: Record<string, number | string | null>; option?: Record<string, number | string | null>; regime?: string; scalp?: ScalpCalc };
  session?: { time_ist: string; trading_day: boolean; window: string; market_open: boolean; entry_permitted: boolean };
  pipeline?: { decision: string; reasons: string[]; gates: PipelineGate[] };
  strategy_decision?: string;
  strategy_reason?: string;
  strategy_setup?: { side: string; entry: number; stop_loss: number; target: number; risk_reward?: number } | null;
};
type Order = {
  id: string; symbol: string; strategy?: string; strategyName?: string; side: string; quantity: number; lotSize?: number; price: number; status: string; mode?: string;
  target?: number; stopLoss?: number; trailingStop?: number; trailingDistance?: number; highWaterMark?: number; trailingActivatedAt?: string; currentPrice?: number; pnl?: number; pnlPercent?: number; quoteSource?: string;
  createdAt: string; exitPrice?: number; exitReason?: string; realizedPnl?: number; realizedPnlPercent?: number; exitError?: string; reconcileWarning?: string;
};
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type QuoteUpdate = { symbol: string; price: number | null; timestamp: string; source: string };
type OptionCandidate = { symbol: string; contract: "CALL" | "PUT"; expiry: string; strike: number; premium: number; bid: number; ask: number; openInterest: number; volume: number; iv: number; delta: number; theta?: number; score: number; riskReward: number; lotSize?: number; tickSize?: number; freezeQuantity?: number };
type Contract = { symbol: string; growwSymbol: string; type: "CE" | "PE"; expiry?: string; strike?: number; lotSize: number; tickSize?: number; freezeQuantity?: number; active?: boolean };
type SearchResult = Contract & { exchange?: string };
type RiskReward = "1:1" | "1:2";
type NextDayPlan = NonNullable<NextDaySetup["plans"]>[number];
type LiveStatus = { enabled: boolean; disabledReasons: string[]; limits?: { maxDailyLoss: number; maxTradesPerDay: number; maxLotsPerOrder: number; maxOrderValue: number; maxOpenPositions: number; minRewardRisk: number }; today?: { tradesToday: number; realizedPnl: number; openRisk: number; lossBudgetLeft: number }; positions: Order[]; monitor?: { running: boolean; lastTickAt: string | null; lastError: string | null } };
type Tab = "LIVE" | "PAPER" | "HISTORY" | "LOGS";
type Log = { time: string; text: string; type: "entry" | "exit" | "info" };

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const TICKER = ["NIFTY", "BANKNIFTY", "SENSEX", "INDIA VIX"];
const FALLBACK_LOT: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 }; // used only if the contract master is unreachable
// The algo page runs one strategy: the 1-minute VWAP / 5-9 EMA index-option scalper.
const strategy = { id: "VWAP_EMA_SCALP", name: "VWAP-EMA Scalper", description: "1-minute index tape: trade the side of a rising (falling) VWAP when the 5 EMA leads the 9 EMA, after a pullback to the 9 EMA resumes on volume. The strike is picked from the OI data (delta 0.40-0.60, OI, volume, build-up); OI writers, PCR, the premium's own volume profile and India VIX must all agree. The stop sits beyond the pullback in index points and is mapped onto the premium with delta and gamma, for the 1:1 or 1:2 you choose." } as const;
const RR_CHOICES: Array<{ id: RiskReward; name: string }> = [
  { id: "1:2", name: "Risk:Reward 1:2" },
  { id: "1:1", name: "Risk:Reward 1:1" },
];
const SCALPER_SETTINGS_KEY = "tradepulse.scalper.settings";
const STRATEGY_PREFS_KEY = "tradepulse.scalp.prefs";
type ScalperLimits = { maxTrades?: number; maxLossPerTrade?: number; maxDailyLoss?: number; lots?: number; minRiskReward?: number; mode?: string; maxHoldMinutes?: number };
function readLocal<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback; } catch { return fallback; }
}
const epochOf = (iso: string | null | undefined) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? Math.floor(value / 1000) : null; };
const money = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const calc = (value: unknown, percent = false) => formatMarketCalculationValue(value as number | string | null | undefined, { percent });
const norm = (value: string | undefined | null) => String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const istDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const nowLabel = () => new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
// Socket ticks are folded into state at most this often, so a burst of quotes is one render.
const TICK_FLUSH_MS = 250;

/** The IST clock owns its 1-second timer, so the rest of the page doesn't re-render every second. */
const IstClock = memo(function IstClock() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => setClock(nowLabel());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="exec-badge">IST {clock || "--:--:--"}</span>;
});

/**
 * Mounts a display-only panel when it comes near the viewport (its data loads only then) and
 * keeps it mounted afterwards. Panels that trade or monitor on their own are never wrapped.
 */
function WhenVisible({ children, minHeight = 240 }: { children: ReactNode; minHeight?: number }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (shown || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setShown(true); }, { rootMargin: "600px 0px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [shown]);
  return shown ? <>{children}</> : <div ref={ref} className="algo-empty" style={{ minHeight }} aria-hidden="true" />;
}

export default function ExecutionPage() {
  const [symbol, setSymbol] = useState<string>("NIFTY");
  // Per-viewer preferences: the chosen reward:risk and whether confirmed scalps are auto-placed.
  const [riskReward, setRiskReward] = useState<RiskReward>("1:2");
  const [scalperRefresh, setScalperRefresh] = useState(0);
  const [premiumBars, setPremiumBars] = useState<ChartBar[]>([]);
  const attemptedSetups = useRef(new Set<string>());
  useEffect(() => { const prefs = readLocal(STRATEGY_PREFS_KEY, { riskReward: "1:2" as RiskReward }); setRiskReward(prefs.riskReward === "1:1" ? "1:1" : "1:2"); }, []);
  useEffect(() => { try { window.localStorage.setItem(STRATEGY_PREFS_KEY, JSON.stringify({ riskReward })); } catch { /* per-viewer convenience */ } }, [riskReward]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [paperOrders, setPaperOrders] = useState<Order[]>([]);
  const [history, setHistory] = useState<Order[]>([]);
  const [account, setAccount] = useState<{ available: number | null; source: string } | null>(null);
  const [safety, setSafety] = useState({ safeMode: false, killSwitch: false, reason: "" });
  const [message, setMessage] = useState("Paper mode is the default. Live orders need server enablement and a PIN-confirmed preview.");
  const [busy, setBusy] = useState(false);
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
  const [trailing, setTrailing] = useState("");
  const [ticketSource, setTicketSource] = useState("MANUAL");
  // ALGO orders are re-validated by the server's V5 pipeline; MANUAL orders are user-authorised.
  const [ticketOrigin, setTicketOrigin] = useState<"MANUAL" | "ALGO">("MANUAL");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [live, setLive] = useState<LiveStatus | null>(null);
  const [liveDraft, setLiveDraft] = useState<LiveTicketDraft | null>(null);
  const [livePin, setLivePin] = useState("");

  // Smart scalper desk (paper): it owns its engine; the page only needs to know whether it is on.
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [chainExpiry, setChainExpiry] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("PAPER");
  const [logs, setLogs] = useState<Log[]>([]);
  const log = useCallback((text: string, type: Log["type"] = "info") => setLogs((current) => [{ time: nowLabel(), text, type }, ...current].slice(0, 200)), []);

  const lotSize = contract?.lotSize ?? FALLBACK_LOT[symbol] ?? 1;
  const spot = candles.at(-1)?.close ?? quotes[symbol] ?? 0;

  // ---- data loading -------------------------------------------------------------------
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    const version = mutationVersion.current;
    try {
      // The scalper sizes to the Smart Scalper desk's own limits (max loss per trade, lots).
      const limits = readLocal<ScalperLimits>(SCALPER_SETTINGS_KEY, {});
      const data = await fetch(`/api/algo-trading?symbol=${symbol}&provider=groww&strategy=${strategy.id}&rr=${encodeURIComponent(riskReward)}${limits.maxLossPerTrade ? `&maxLoss=${limits.maxLossPerTrade}` : ""}${limits.lots ? `&lots=${limits.lots}` : ""}`, { cache: "no-store" }).then((response) => response.json());
      setAnalysis(data.analysis ?? null);
      setAccount(data.account ?? null);
      setSafety({ safeMode: Boolean(data.safeMode), killSwitch: Boolean(data.killSwitch), reason: data.killSwitchReason ?? data.safeModeReason ?? "" });
      if (version === mutationVersion.current) {
        // Smart-scalper positions are managed (and shown) by the scalper desk.
        setPaperOrders((data.orders ?? []).filter((order: Order) => order.mode !== "ALGO_LIVE" && order.strategy !== "SMART_SCALPER"));
        setHistory(data.history ?? []);
      }
      if (data.error) setMessage(data.error);
    } catch { setMessage("Strategy engine unavailable; retrying on the next refresh."); }
    finally { if (!quiet) setBusy(false); }
  }, [riskReward, symbol]);

  const refreshLive = useCallback(async () => {
    try { setLive(await fetch("/api/live-orders", { cache: "no-store" }).then((response) => response.json())); } catch { /* status is advisory */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // The scalper only sees COMPLETED 1-minute candles and a trigger is actionable for about one
  // candle, so re-run it a few seconds after every minute closes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const now = Date.now();
      const nextClose = Math.ceil(now / 60_000) * 60_000 + 4_000;
      timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(true); schedule(); }, nextClose - now);
    };
    schedule();
    return () => { if (timer) clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    void refreshLive();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refreshLive(); }, 10_000);
    return () => clearInterval(timer);
  }, [refreshLive]);

  // One history request (cached server-side) + one chain request. The old page also called
  // /api/options-engine, which always failed on Groww chains (no bid/ask) before falling back.
  // The scalper desk needs the strike ladder, so load the full chain and keep ATM ±8 strikes
  // (≤ 34 contracts, inside the quote socket's 60-option subscription cap). Greeks/OI refresh
  // every minute; premiums tick live over the socket in between.
  useEffect(() => {
    let cancelled = false;
    setChainStatus("Loading option chain…");
    setChainExpiry(null);
    fetch(`/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=5m&period=day&date=${istDate()}`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({})).then((historyBody) => {
      if (cancelled) return;
      const nextCandles: Candle[] = Array.isArray(historyBody.candles) ? historyBody.candles : [];
      candlesRef.current = nextCandles;
      setCandles(nextCandles);
    });
    // Shared with the options-strategy panel: one request per minute serves both.
    const loadChain = () => fetchJsonShared<Record<string, any>>(`/api/option-chain?symbol=${symbol}&full=1`, 20_000).catch(() => ({} as Record<string, any>)).then((chainBody) => {
      if (cancelled) return;
      const all: OptionCandidate[] = Array.isArray(chainBody.contracts) ? chainBody.contracts : [];
      const strikes = [...new Set(all.map((item) => item.strike))].sort((a, b) => a - b);
      const spotNow = Number(chainBody.spot) || candlesRef.current.at(-1)?.close || 0;
      const atm = strikes.reduce((best, strike, index) => (Math.abs(strike - spotNow) < Math.abs(strikes[best] - spotNow) ? index : best), 0);
      const keep = new Set(strikes.slice(Math.max(0, atm - 8), atm + 9));
      const live = new Map(chainRef.current.map((item) => [norm(item.symbol), item.premium]));
      const contracts = all.filter((item) => keep.has(item.strike)).map((item) => ({ ...item, premium: live.get(norm(item.symbol)) ?? item.premium }));
      if (!contracts.length && chainRef.current.length) return;
      chainRef.current = contracts;
      setChain(contracts);
      setChainExpiry(chainBody.expiry ?? null);
      setChainStatus(contracts.length ? `Live ${symbol} chain · ${chainBody.expiry ?? ""}` : `Option chain unavailable${chainBody.error ? `: ${chainBody.error}` : ""}`);
    });
    void loadChain();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadChain(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol]);

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

    // Ticks arrive one message at a time; each used to be its own render of the whole page. They
    // are now collected here and applied together at most every TICK_FLUSH_MS.
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingQuotes: Record<string, number> = {};
    const pendingChain = new Map<string, number>();
    const pendingOrders = new Map<string, number>();
    let candlesDirty = false;
    const flush = () => {
      flushTimer = null;
      if (closed) return;
      if (Object.keys(pendingQuotes).length) {
        const next = { ...pendingQuotes };
        for (const key of Object.keys(pendingQuotes)) delete pendingQuotes[key];
        setQuotes((current) => (Object.entries(next).every(([key, value]) => current[key] === value) ? current : { ...current, ...next }));
      }
      if (candlesDirty) { candlesDirty = false; setCandles(candlesRef.current); }
      if (pendingChain.size) {
        let touched = false;
        const nextChain = chainRef.current.map((item) => { const price = pendingChain.get(norm(item.symbol)); if (!price || price === item.premium) return item; touched = true; return { ...item, premium: price, bid: price, ask: price }; });
        pendingChain.clear();
        if (touched) { chainRef.current = nextChain; setChain(nextChain); }
      }
      if (pendingOrders.size) {
        const prices = new Map(pendingOrders);
        pendingOrders.clear();
        setPaperOrders((current) => {
          let touched = false;
          const next = current.map((order) => {
            const price = prices.get(norm(order.symbol));
            if (!price || price === order.currentPrice) return order;
            touched = true;
            const pnl = (price - order.price) * order.quantity;
            const highWaterMark = order.trailingDistance ? Math.max(order.highWaterMark ?? order.price, price) : order.highWaterMark;
            return { ...order, currentPrice: price, highWaterMark, pnl, pnlPercent: order.price ? (price - order.price) / order.price * 100 : 0, quoteSource: "Groww live" };
          });
          return touched ? next : current;
        });
      }
    };
    const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, TICK_FLUSH_MS); };

    const applyMarkets = (items: Array<{ symbol?: string; price?: number | null }>) => {
      let any = false;
      for (const item of items) if (item.symbol && typeof item.price === "number" && item.price > 0) { pendingQuotes[item.symbol] = item.price; any = true; }
      if (any) scheduleFlush();
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
      candlesDirty = true;
      scheduleFlush();
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
          pendingQuotes[payload.quote.symbol || symbol] = price;
          onTick(price);
          return;
        }
        const updates = payload.quotes;
        if ((payload.type === "chain" || payload.type === "quotes") && updates?.length) {
          const prices = new Map<string, number>();
          for (const quote of updates) if (quote.price && quote.price > 0) prices.set(norm(quote.symbol), quote.price);
          if (!prices.size) return;
          for (const [key, price] of prices) (payload.type === "chain" ? pendingChain : pendingOrders).set(key, price);
          scheduleFlush();
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flushTimer) clearTimeout(flushTimer);
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
    const enriched = await withMetadata(contract!);
    setContract(enriched);
    const premium = premiumFor(enriched);
    if (!premium) { setMessage("No live premium for this contract yet; wait for the chain to load or pick a near-ATM strike."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/algo-trading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        mode: "PAPER", orderSource: ticketOrigin, strategy: strategy.id, strategyName: `${strategy.name}${ticketSource !== "MANUAL" ? ` · ${ticketSource}` : ""}`, underlying: symbol,
        symbol: enriched.symbol, growwSymbol: enriched.growwSymbol, side: "BUY", quantity: lots * enriched.lotSize, lotSize: enriched.lotSize, price: premium,
        target: Number(target), stopLoss: Number(stopLoss), ...(Number(trailing) > 0 ? { trailingDistance: Number(trailing) } : {}), riskReward, maxLossPerTrade: readLocal<ScalperLimits>(SCALPER_SETTINGS_KEY, {}).maxLossPerTrade, maxLots: readLocal<ScalperLimits>(SCALPER_SETTINGS_KEY, {}).lots, expiry: enriched.expiry, optionType: enriched.type, strike: enriched.strike,
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
    setTrailing("");
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
  const loadAdvice = useCallback((advice: OptionAdvice) => {
    if (!advice.contract || !advice.premium) return;
    const size = advice.lotSize && advice.lotSize > 0 ? advice.lotSize : FALLBACK_LOT[advice.symbol] ?? 1;
    setContract({ symbol: advice.contract.trading_symbol, growwSymbol: advice.contract.trading_symbol, type: advice.contract.side, expiry: advice.expiry ?? undefined, strike: advice.contract.strike, lotSize: size });
    setLots(1);
    setStopLoss(String(advice.premium.stop));
    setTarget(String(advice.premium.target1));
    setTrailing("");
    setTicketSource(`AI ${advice.source === "AI" ? "advisor" : "rule-based"}`);
    setTicketOrigin("MANUAL");
    setMessage(`AI suggestion loaded: BUY ${advice.contract.trading_symbol} · SL ₹${advice.premium.stop} · T1 ₹${advice.premium.target1}. Review before placing.`);
    document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const aiContext = useCallback(() => ({
    symbol, timeframe: "5m", executionMode: live?.enabled ? "ALGO_LIVE_ARMED" : "PAPER", marketStatus: sessionLabelRef.current, deterministicAnalysis: analysis,
    candles: candlesRef.current.slice(-30), optionCandidates: [...chainRef.current].sort((left, right) => right.score - left.score).slice(0, 20), risk: { safeMode: safety.safeMode, killSwitch: safety.killSwitch, autoTradeEnabled: autoEnabled },
  }), [analysis, autoEnabled, live?.enabled, safety.killSwitch, safety.safeMode, symbol]);
  const sessionLabelRef = useRef("--");

  // The engine has already chosen the strike and the premium entry, stop, trail and target.
  // A next-day plan is a manual ticket: its premium is an estimate until the market opens.
  const loadNextDayPlan = useCallback((plan: NextDayPlan, setup: NextDaySetup) => {
    if (!plan.contract || !plan.premium) return;
    const picked = plan.contract;
    const row = chainRef.current.find((item) => norm(item.symbol) === norm(picked.symbol));
    setContract({ symbol: picked.symbol, growwSymbol: picked.symbol, type: picked.type, expiry: picked.expiry ?? row?.expiry, strike: picked.strike, lotSize: Number(picked.lot_size) > 0 ? Number(picked.lot_size) : row?.lotSize || FALLBACK_LOT[setup.symbol] || 1, tickSize: row?.tickSize, freezeQuantity: row?.freezeQuantity });
    setLots(1);
    setStopLoss(String(plan.premium.stop_loss));
    setTarget(String(plan.premium.target));
    setTrailing(String(plan.premium.trailing_distance));
    setTicketSource(`Next-day ${plan.role.toLowerCase()}`);
    setTicketOrigin("MANUAL");
    setMessage(`Next-day plan loaded: BUY ${picked.symbol} only after ${setup.symbol} trades ${plan.option_type === "CE" ? "above" : "below"} ${money(plan.index.trigger)} after 9:30 · est. entry ₹${plan.premium.entry} · SL ₹${plan.premium.stop_loss} · trail ₹${plan.premium.trailing_distance} · target ₹${plan.premium.target}. Re-check the stop and target against the live premium.`);
    document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const loadStrategySetup = useCallback(() => {
    const setup = analysis?.setup;
    if (!setup?.contract || analysis?.pipeline?.decision !== "CONFIRMED") return;
    const picked = setup.contract;
    const row = chainRef.current.find((item) => norm(item.symbol) === norm(picked.symbol));
    setContract({ symbol: picked.symbol, growwSymbol: picked.symbol, type: picked.type, expiry: picked.expiry ?? row?.expiry, strike: picked.strike, lotSize: Number(picked.lot_size) > 0 ? Number(picked.lot_size) : row?.lotSize || FALLBACK_LOT[symbol] || 1, tickSize: picked.tick_size ?? row?.tickSize, freezeQuantity: picked.freeze_quantity ?? row?.freezeQuantity });
    setLots(Math.max(1, setup.lots ?? 1));
    setStopLoss(String(setup.stop_loss));
    setTarget(String(setup.target));
    setTrailing("");
    setTicketSource(`${strategy.name} ${setup.rr_choice ?? riskReward}`);
    setTicketOrigin("ALGO");
    setMessage(`${strategy.name} setup loaded: BUY ${picked.symbol} near ₹${setup.entry} · SL ₹${setup.stop_loss} · target ₹${setup.target} (${setup.rr_choice ?? riskReward} on the index, ${setup.risk_reward}R on the premium). The server re-checks every V5 gate when you place it.`);
    document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [analysis, riskReward, symbol]);

  // ---- place on the Smart Scalper (paper) --------------------------------------------------
  // The server re-runs the scalper and every V5 gate before it places anything; the scalper book's
  // own limits (trade cap, max loss, daily loss, loss streak, one position, 15:15) still apply.
  const placeOnScalper = useCallback(async (reason: "AUTO" | "MANUAL"): Promise<{ placed: boolean; error?: string }> => {
    const setup = analysis?.setup;
    if (!setup?.setup_id || analysis?.pipeline?.decision !== "CONFIRMED") return { placed: false, error: "No confirmed VWAP-EMA setup" };
    attemptedSetups.current.add(setup.setup_id);
    try {
      const response = await fetch("/api/algo-trading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "PLACE_ON_SCALPER", underlying: symbol, riskReward, settings: readLocal<ScalperLimits>(SCALPER_SETTINGS_KEY, {}), contracts: chainRef.current,
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.placed) {
        const text = `${reason === "AUTO" ? "Auto-place" : "Place"} on scalper refused: ${data.error ?? "request failed"}${Array.isArray(data.reasons) && data.reasons.length ? ` (${data.reasons.slice(0, 4).join(", ")})` : ""}`;
        setMessage(text);
        log(text, "info");
        return { placed: false, error: String(data.error ?? "refused") };
      }
      setScalperRefresh((value) => value + 1);
      setMessage(`${reason === "AUTO" ? "Auto-placed" : "Placed"} on the Smart Scalper (paper): ${data.summary ?? ""}`);
      log(`[${strategy.name}] ${data.summary ?? "placed on the scalper"}`, "entry");
      return { placed: true };
    } catch { setMessage("Place on scalper request failed"); return { placed: false, error: "request failed" }; }
  }, [analysis, log, riskReward, symbol]);

  // The selected premium's 1-minute candles (the scalper's volume-profile series), folded with
  // the live premium from the chain socket.
  const scalpSymbol = analysis?.calculations?.scalp?.selected?.symbol ?? analysis?.setup?.contract?.symbol ?? "";
  useEffect(() => {
    if (!scalpSymbol) { setPremiumBars([]); return; }
    let cancelled = false;
    const load = () => fetch(`/api/market-data/option-history?symbol=${encodeURIComponent(scalpSymbol)}&timeframe=1m`, { cache: "no-store" }).then((response) => response.json())
      .then((body) => { if (!cancelled && Array.isArray(body.candles)) setPremiumBars(body.candles as ChartBar[]); }).catch(() => undefined);
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [scalpSymbol]);
  const scalpPremium = chain.find((item) => norm(item.symbol) === norm(scalpSymbol))?.premium;
  useEffect(() => {
    if (!(scalpPremium && scalpPremium > 0)) return;
    setPremiumBars((current) => {
      const bucket = Math.floor(Date.now() / 60_000) * 60;
      const last = current.at(-1);
      if (!last || bucket > last.time) return [...current.slice(-400), { time: bucket, open: last?.close ?? scalpPremium, high: Math.max(last?.close ?? scalpPremium, scalpPremium), low: Math.min(last?.close ?? scalpPremium, scalpPremium), close: scalpPremium }];
      return [...current.slice(0, -1), { ...last, high: Math.max(last.high, scalpPremium), low: Math.min(last.low, scalpPremium), close: scalpPremium }];
    });
  }, [scalpPremium]);

  const switchIndex = useCallback((next: string) => { setSymbol(next); setContract(null); setResults([]); setQuery(""); }, []);

  // ---- derived ---------------------------------------------------------------------------
  const openPaper = useMemo(() => paperOrders.filter((order) => ["OPEN", "FILLED"].includes(order.status)), [paperOrders]);
  const paperPnl = openPaper.reduce((sum, order) => sum + (order.pnl ?? 0), 0);
  const livePositions = live?.positions ?? [];
  const livePnl = livePositions.reduce((sum, order) => sum + (order.pnl ?? 0), 0);
  const sessionLabel: string = !analysis?.session ? "--" : !analysis.session.market_open ? "MARKET CLOSED" : analysis.session.entry_permitted ? "ENTRY WINDOW" : analysis.session.window.replaceAll("_", " ");
  sessionLabelRef.current = sessionLabel;
  const score = analysis?.calculations?.score ?? {};
  const underlying = analysis?.calculations?.underlying ?? {};
  const regime = analysis?.calculations?.regime;
  const { vwap, ema20, ema50 } = underlying;
  const scalp = analysis?.calculations?.scalp;
  const scalpPlan = scalp?.plan ?? null;
  const scalpSide = scalp?.selected?.type ?? scalp?.tape.side ?? null;
  // Pipeline gate codes are shared with the other strategies; name them for this one.
  const GATE_LABELS: Record<string, string> = { BREAKOUT_INVALID: "VWAP", RETEST_NOT_CONFIRMED: "5/9 EMA trigger", STRATEGY_NOT_CONFIRMED: "strategy", PREMIUM_TARGET_UNREACHABLE: "charges vs reward", RR_BELOW_MINIMUM: `R:R ${scalp?.rr_choice ?? riskReward}` };
  // The risk-reward drawing on the selected premium: the confirmed setup, else the plan in progress.
  const rrBox: RiskRewardBox | null = useMemo(() => {
    const setup = analysis?.setup;
    if (setup?.contract && setup.entry && setup.stop_loss && setup.target) return { entry: setup.entry, stop: setup.stop_loss, target: setup.target, fromTime: epochOf(setup.trigger_time), quantity: setup.quantity, label: `BUY ${setup.contract.type} ${setup.rr_choice ?? riskReward}` };
    if (scalpPlan?.entry && scalpPlan.stop_loss && scalpPlan.target && scalpPlan.stop_loss < scalpPlan.entry && scalpPlan.target > scalpPlan.entry) return { entry: scalpPlan.entry, stop: scalpPlan.stop_loss, target: scalpPlan.target, fromTime: epochOf(scalp?.trigger?.time), quantity: scalpPlan.quantity, label: `Plan ${riskReward} (not confirmed)` };
    return null;
  }, [analysis?.setup, riskReward, scalp?.trigger?.time, scalpPlan]);
  // The scalper read handed to the Smart Scalper desk, which trades it (auto or manual).
  const vwapScalp: VwapScalpSignal | null = useMemo(() => {
    if (!scalp) return null;
    const setup = analysis?.setup;
    const confirmed = analysis?.pipeline?.decision === "CONFIRMED" && Boolean(setup?.contract && setup.setup_id);
    const picked = scalp.selected ? { symbol: scalp.selected.symbol, strike: scalp.selected.strike, type: scalp.selected.type } : null;
    const planned = confirmed && setup ? { entry: setup.entry, stop: setup.stop_loss, target: setup.target, quantity: setup.quantity, rrChoice: setup.rr_choice ?? riskReward, riskReward: setup.risk_reward, netRiskReward: setup.net_risk_reward }
      : scalpPlan?.entry && scalpPlan.stop_loss && scalpPlan.target ? { entry: scalpPlan.entry, stop: scalpPlan.stop_loss, target: scalpPlan.target, quantity: scalpPlan.quantity, rrChoice: scalp.rr_choice, riskReward: scalpPlan.risk_reward, netRiskReward: scalpPlan.net_risk_reward } : null;
    const failedGates = (analysis?.pipeline?.gates ?? []).filter((gate) => !gate.passed).map((gate) => GATE_LABELS[gate.code] ?? gate.code.toLowerCase().replaceAll("_", " "));
    return {
      confirmed, setupId: confirmed ? setup?.setup_id ?? null : null, side: scalp.tape.side ?? null, selected: picked, plan: planned, triggerTime: setup?.trigger_time ?? scalp.trigger?.time ?? null,
      criteriaMet: scalp.criteria.filter((item) => item.passed).length, criteriaTotal: scalp.criteria.length,
      waitingOn: [...scalp.criteria.filter((item) => !item.passed).map((item) => item.name), ...(scalp.criteria.every((item) => item.passed) ? failedGates : [])],
      reason: String(analysis?.strategy_reason ?? scalp.tape.reason ?? ""),
    };
  }, [analysis, riskReward, scalp, scalpPlan]);
  const profileLevels: ChartLevel[] = useMemo(() => scalp?.profile ? [
    { price: scalp.profile.poc, color: "#f0c36b", title: "POC", dashed: true },
    { price: scalp.profile.vah, color: "#8fa3a8", title: "VAH", dashed: true },
    { price: scalp.profile.val, color: "#8fa3a8", title: "VAL", dashed: true },
  ] : [], [scalp?.profile]);
  const strategyTrend = useMemo(() => ({ regime: regime ?? null, vwap: Number(vwap) || null, ema20: Number(ema20) || null, ema50: Number(ema50) || null }), [regime, vwap, ema20, ema50]);
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
          <IstClock />
          <span className={streamStatus === "live" ? "exec-badge gain" : "exec-badge warning"}>Quotes {streamStatus}</span>
          <button type="button" className="exec-badge exec-badge-button" onClick={() => void clearCache()} disabled={cacheClearing}>{cacheClearing ? "Clearing…" : "Clear cache"}</button>
          <span className="exec-badge">Margin {account?.available !== null && account?.available !== undefined ? `₹${money(account.available)}` : "--"}</span>
        </div>
      </header>

      <div className="exec-content">
        <p className="exec-message" role="status">{message}</p>
        <MarketIntelPanel symbol={symbol} onSymbolChange={switchIndex} onUsePlan={loadPlan} />
        <WhenVisible><OptionStrategyPanel symbol={symbol} onSymbolChange={switchIndex} vix={quotes["INDIA VIX"] ?? null} trend={strategyTrend} /></WhenVisible>
        <AIMonitoringPanel symbol={symbol} strategyId={strategy.id} buildContext={aiContext} onLoadAdvice={loadAdvice} />

        <WhenVisible minHeight={160}><NextDayPanel symbol={symbol} onSymbolChange={switchIndex} onUsePlan={loadNextDayPlan} /></WhenVisible>

        <div className="exec-grid">
          <article className="mi-card exec-strategy">
            <div className="algo-panel-head">
              <div><span className="algo-kicker">V5 RULE ENGINE · VWAP-EMA SCALPER · {symbol}</span><h2>{strategy.name}: <span className={analysis?.pipeline?.decision === "CONFIRMED" ? "gain" : "warning"}>{analysis?.pipeline?.decision ?? analysis?.decision ?? "WAITING"}</span></h2></div>
              <div className="exec-strategy-controls">
                <select aria-label="Risk reward" value={riskReward} onChange={(event) => setRiskReward(event.target.value as RiskReward)} title="Target as a multiple of the stop distance on the index; the premium target follows from delta and gamma">{RR_CHOICES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                <button type="button" className="exec-auto-place" onClick={() => document.querySelector(".scalper")?.scrollIntoView({ behavior: "smooth", block: "start" })} title="Automatic placing runs on the Scalper: Strategy VWAP-EMA, Engine on, Trade Automatic">Auto-trade on the Scalper ↓</button>
                <button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? "…" : "Refresh"}</button>
              </div>
            </div>
            <p className="mi-note">{strategy.description}</p>
            {analysis?.setup?.contract ? (
              <div className="exec-setup"><b className={analysis.setup.contract.type === "PE" ? "loss" : "gain"}>BUY {analysis.setup.contract.symbol} × {analysis.setup.quantity ?? "--"}</b><span>Premium entry ₹{money(analysis.setup.entry)} · SL ₹{money(analysis.setup.stop_loss)} · target ₹{money(analysis.setup.target)} · {analysis.setup.rr_choice} on the index = {analysis.setup.risk_reward}R on the premium ({analysis.setup.net_risk_reward}R after charges) · max loss ₹{money(analysis.setup.planned_max_loss)} planned / ₹{money(analysis.setup.max_loss)} stressed · refused if filled above ₹{money(analysis.setup.max_entry)}</span></div>
            ) : null}
            {analysis?.setup?.contract && analysis.pipeline?.decision === "CONFIRMED" && (
              <div className="exec-actions">
                <button type="button" className="exec-paper" onClick={() => void placeOnScalper("MANUAL")} disabled={busy || attemptedSetups.current.has(analysis.setup.setup_id ?? "")}>Place on Scalper (paper)</button>
                <button type="button" className="mi-use-plan" onClick={loadStrategySetup}>Load into the order ticket</button>
              </div>
            )}
            <div className="exec-score">
              {(scalp?.criteria ?? []).map((item) => (
                <span key={item.key} className={item.passed ? "pass" : "fail"} title={item.detail}><small>{item.name}</small><b className={item.passed ? "gain" : "warning"}>{item.points} / {item.max}</b></span>
              ))}
              <span className="exec-score-total"><small>Criteria met</small><b className={Number(scalp?.score?.total ?? 0) >= Number(scalp?.score?.minimum ?? 10) ? "gain" : "warning"}>{calc(scalp?.score?.total ?? score.total)} / 10</b><em>all 10 needed</em></span>
            </div>
            {scalp && (
              <ul className="exec-criteria" aria-label="Scalper criteria">
                {scalp.criteria.map((item) => <li key={item.key} className={item.passed ? "gain" : "warning"}><b>{item.passed ? "✓" : "✗"} {item.name}</b> {item.detail}</li>)}
              </ul>
            )}
            {scalp?.selected && (
              <div className="exec-orb" aria-label="Selected premium">
                <span>Premium (auto-selected from OI) <b className={scalp.selected.type === "PE" ? "loss" : "gain"}>{scalp.selected.symbol}</b> · ₹{money(scalp.selected.premium)} · Δ {calc(scalp.selected.delta)}{scalpPlan?.greeks ? ` · Γ ${scalpPlan.greeks.gamma.toFixed(5)} · θ ₹${money(scalpPlan.greeks.theta_per_day)}/day · IV ${calc(scalpPlan.greeks.iv)}%` : ""}</span>
                <span>OI {money(scalp.selected.open_interest)}{scalp.selected.oi_change_5m !== null && scalp.selected.oi_change_5m !== undefined ? ` (${scalp.selected.oi_change_5m >= 0 ? "+" : ""}${money(scalp.selected.oi_change_5m)} in 5m)` : ""} · volume {money(scalp.selected.volume)} · {scalp.selected.activity ? scalp.selected.activity.replaceAll("_", " ").toLowerCase() : "no 5m build-up yet"} · liquidity {scalp.selected.liquidity_score}/3</span>
                {scalp.candidates.length > 1 && <small>Next strikes: {scalp.candidates.slice(1, 4).map((item) => `${money(item.strike)} ${item.type} (Δ ${calc(item.delta)}, score ${calc(item.selection_score)}${item.activity ? `, ${item.activity.replaceAll("_", " ").toLowerCase()}` : ""})`).join(" · ")}</small>}
              </div>
            )}
            {scalpPlan && scalpPlan.entry !== undefined && (
              <div className="exec-orb" aria-label="Delta-gamma risk reward">
                <span>Index <b>{scalpSide === "PE" ? "short" : "long"}</b> from {money(scalpPlan.spot_entry)} · stop {money(scalpPlan.spot_stop)} ({calc(scalpPlan.risk_points)} pts) · target {money(scalpPlan.spot_target)} ({calc(scalpPlan.target_points)} pts, {scalp?.rr_choice})</span>
                <span>Premium SL = ₹{money(scalpPlan.entry)} − (Δ×{calc(scalpPlan.risk_points)} = ₹{money(scalpPlan.premium_loss_delta_only)} {(scalpPlan.gamma_effect?.on_loss ?? 0) <= 0 ? "−" : "+"} Γ ₹{money(Math.abs(scalpPlan.gamma_effect?.on_loss ?? 0))} + θ ₹{money(scalpPlan.theta_drag)}) = <b className="loss">₹{money(scalpPlan.stop_loss)}</b></span>
                <span>Premium target = ₹{money(scalpPlan.entry)} + (Δ×{calc(scalpPlan.target_points)} = ₹{money(scalpPlan.premium_gain_delta_only)} + Γ ₹{money(scalpPlan.gamma_effect?.on_gain)} − θ ₹{money(scalpPlan.theta_drag)}) = <b className="gain">₹{money(scalpPlan.target)}</b></span>
                <span>Premium R:R <b>{calc(scalpPlan.risk_reward)}</b> · after charges <b>{calc(scalpPlan.net_risk_reward)}</b> · stressed <b>{calc(scalpPlan.stressed_risk_reward)}</b> · charges + slippage ₹{money(scalpPlan.costs_per_lot?.at_target)}/lot ({scalpPlan.cost_share !== undefined ? `${Math.round(scalpPlan.cost_share * 100)}%` : "--"} of the reward, max 25%)</span>
                <span>{scalpPlan.lots ?? 0} lot(s) · max loss ₹{money(scalpPlan.planned_max_loss)} planned / <b>₹{money(scalpPlan.max_loss)} stressed</b> (stop gap ₹{money(scalpPlan.stop_gap)}/unit, slippage {scalpPlan.slippage_pct !== undefined ? `${(scalpPlan.slippage_pct * 100).toFixed(2)}%` : "--"} each leg) · fill tolerance up to ₹{money(scalpPlan.max_entry)}</span>
                {!scalpPlan.valid && scalpPlan.reason ? <small className="warning">{scalpPlan.reason}</small> : null}
              </div>
            )}
            {scalpSymbol ? (
              <div className="exec-premium-chart">
                <small className="mi-note">{scalpSymbol} · 1-minute premium{scalp?.profile ? ` · POC ₹${money(scalp.profile.poc)} · value area ₹${money(scalp.profile.val)}–₹${money(scalp.profile.vah)}` : ""}{rrBox ? ` · ${rrBox.label}` : ""}</small>
                <PremiumChart bars={premiumBars} levels={profileLevels} riskReward={rrBox} height={280} />
              </div>
            ) : null}
            <p className="mi-note">{String(analysis?.strategy_reason ?? scalp?.tape.reason ?? analysis?.reason ?? "Waiting for the engine…")}</p>
            {analysis?.pipeline ? (
              <p className="mi-note"><b>Rule gates {analysis.pipeline.gates.filter((gate) => gate.passed).length}/{analysis.pipeline.gates.length} passing</b>: every gate must pass; one red gate blocks the trade. Auto-place and the server re-check use the same gates.</p>
            ) : null}
            <div className="exec-gates">{(analysis?.pipeline?.gates ?? []).map((gate) => <span key={gate.code} className={gate.passed ? "pass" : "fail"} title={gate.detail}>{gate.passed ? "✓" : "✗"} {GATE_LABELS[gate.code] ?? gate.code.replace(/_(BLOCKED|NOT_CONFIRMED|NOT_SUPPORTIVE|BELOW_MINIMUM|UNRESOLVED|MISSING|REQUIRED|UNHEALTHY|STALE|INVALID|NOT_READY)$/, "").replaceAll("_", " ").toLowerCase()}</span>)}</div>
            <details className="mi-management">
              <summary>Show calculations</summary>
              <div className="exec-calcs">
                <span>Close <b>{calc(scalp?.tape.close)}</b></span><span>VWAP <b>{calc(scalp?.tape.vwap)}</b> <small>{scalp?.tape.vwap_slope !== undefined ? `${scalp.tape.vwap_slope >= 0 ? "+" : ""}${calc(scalp.tape.vwap_slope)} pts / 5m` : ""}</small></span>
                <span>EMA 5 / 9 <b>{calc(scalp?.tape.ema5)} / {calc(scalp?.tape.ema9)}</b></span><span>ATR (1m) <b>{calc(scalp?.tape.atr)}</b></span><span>From VWAP <b>{calc(scalp?.tape.vwap_extension_atr)} ATR</b></span>
                <span>Trigger <b>{scalp?.trigger ? scalp.trigger.time.slice(11, 16) : "--"}</b></span><span>Futures volume <b>{scalp?.tape.volume_ratio ? `${calc(scalp.tape.volume_ratio)}×` : "--"}</b></span>
                <span>PCR (OI) <b>{calc(scalp?.pcr?.pcr)}</b> <small>{scalp?.pcr?.pcr_change_5m !== null && scalp?.pcr?.pcr_change_5m !== undefined ? `${scalp.pcr.pcr_change_5m >= 0 ? "+" : ""}${scalp.pcr.pcr_change_5m} / 5m` : ""}</small></span>
                <span>OI flow score <b>{calc(scalp?.oi?.oi_direction_score)}</b></span><span>ATM {calc(scalp?.oi?.atm_strike)} <b>{[scalp?.oi?.atm_activity?.CE && `CE ${scalp.oi.atm_activity.CE.replaceAll("_", " ").toLowerCase()}`, scalp?.oi?.atm_activity?.PE && `PE ${scalp.oi.atm_activity.PE.replaceAll("_", " ").toLowerCase()}`].filter(Boolean).join(", ") || "--"}</b></span>
                <span>OI wall <b>{calc(scalp?.oi?.wall)}</b> <small>{scalp?.oi?.room_points ? `${calc(scalp.oi.room_points)} pts away` : ""}</small></span>
                <span>India VIX <b>{calc(scalp?.vix?.value)}</b> <small>{scalp?.vix?.regime ?? ""}</small></span>
                <span>Premium POC / VAH / VAL <b>{scalp?.profile ? `${money(scalp.profile.poc)} / ${money(scalp.profile.vah)} / ${money(scalp.profile.val)}` : "--"}</b></span>
                <span>Gap day <b>{calc(analysis?.calculations?.gap?.status)}</b></span>{analysis?.session && "expiry_day" in analysis.session && (analysis.session as { expiry_day?: boolean }).expiry_day ? <span>Expiry day <b className="warning">gamma is high: the premium stop and target move fast</b></span> : null}
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
              <label>Trailing SL (₹ below high)<input type="number" min={0} step={0.05} value={trailing} onChange={(event) => setTrailing(event.target.value)} placeholder="off" /><small>{Number(trailing) > 0 ? "paper stop follows the highest premium" : "optional"}</small></label>
            </div>
            <div className="mi-risk-row"><span>Risk <b className="loss">{ticketRisk !== null ? `₹${money(ticketRisk)}` : "--"}</b></span><span>Reward <b className="gain">{ticketReward !== null ? `₹${money(ticketReward)}` : "--"}</b></span><span>R:R <b>{ticketRisk && ticketReward ? (ticketReward / ticketRisk).toFixed(2) : "--"}</b></span></div>
            <div className="exec-actions">
              <button type="button" className="exec-paper" onClick={() => void placePaper()} disabled={busy}>Paper order</button>
              <button type="button" className="exec-live" onClick={openLive} disabled={busy || !live?.enabled} title={live?.enabled ? "Preview and confirm a real Groww order" : (live?.disabledReasons ?? []).join("\n")}>Live order · real money</button>
            </div>
            {!live?.enabled && <small className="mi-note">Live is off: {(live?.disabledReasons ?? ["status unavailable"]).slice(0, 3).join("; ")}.</small>}
          </article>
        </div>

        <ScalperDesk symbol={symbol} onSymbolChange={switchIndex} chain={chain} expiry={chainExpiry} spot={quotes[symbol] ?? spot} onLog={log} onAutoChange={setAutoEnabled} refreshSignal={scalperRefresh} vwapScalp={vwapScalp} onPlaceVwapScalp={placeOnScalper} />

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
                <td>₹{money(order.stopLoss)} / ₹{money(order.target)}{order.trailingActivatedAt ? <small> trail ₹{money(order.trailingStop)}</small> : order.trailingDistance && (order.highWaterMark ?? order.price) > order.price ? <small> trail ₹{money(getOrderExitState(order, order.currentPrice).effectiveStop)}</small> : null}</td>
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

