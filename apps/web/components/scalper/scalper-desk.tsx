"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PremiumChart, foldTick, regroupBars, type ChartBar, type ChartLevel, type RiskRewardBox } from "./premium-chart";
import type { PositionView, ScalperDecision, ScalperSettings } from "../../../../services/paper-trading/src/smart-scalper";

export type ScalperChainRow = { symbol: string; contract: "CALL" | "PUT"; expiry: string; strike: number; premium: number; bid: number; ask: number; openInterest: number; volume: number; iv: number; delta: number; theta?: number; lotSize?: number; tickSize?: number };
type MonitorStatus = { running: boolean; intervalMs: number; lastTickAt: string | null; lastError: string | null; managedLegs: number; exits: number };
type ScalperState = { positions: PositionView[]; closed: PositionView[]; unrealizedPnl: number; realizedPnl: number; tradesToday: number; decision?: ScalperDecision; summary?: string; error?: string; signalReady?: boolean; monitor?: MonitorStatus };
type View = "CALL" | "SPOT" | "PUT";
/** The algo page's VWAP-EMA scalper read, handed to the desk so it can trade it. */
export type VwapScalpSignal = {
  confirmed: boolean;
  setupId: string | null;
  side: "CE" | "PE" | null;
  selected: { symbol: string; strike: number; type: "CE" | "PE" } | null;
  plan: { entry: number; stop: number; target: number; quantity?: number; rrChoice: string; riskReward?: number; netRiskReward?: number } | null;
  triggerTime: string | null;
  criteriaMet: number;
  criteriaTotal: number;
  waitingOn: string[];
  reason: string;
};
type EngineStrategy = "VWAP_EMA" | "LEVELS";
const TRAIL_TEXT: Record<string, string> = { INITIAL: "initial SL", BREAKEVEN: "breakeven (charges covered)", LOCKED: "+0.5R locked", TRAILING: "trailing 0.6R" };
const epochOf = (iso: string | null | undefined) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? Math.floor(value / 1000) : null; };

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const TIMEFRAMES = [1, 3, 5] as const;
const SETTINGS_KEY = "tradepulse.scalper.settings";
const PREFS_KEY = "tradepulse.scalper.prefs";
const DEFAULT_SETTINGS: ScalperSettings = { maxTrades: 5, maxLossPerTrade: 1500, maxDailyLoss: 4000, lots: 1, minRiskReward: 2, mode: "AUTO", maxHoldMinutes: 12 };
const money = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const signed = (value: number) => `${value >= 0 ? "+" : "-"} ₹${money(Math.abs(value))}`;
const norm = (value: string | undefined | null) => String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const istDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const expiryLabel = (value: string | null | undefined) => (value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }) : "--");
function load<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-viewer convenience only */ } }

/** 1m premium candles for one contract, refreshed every 2 min and folded with live premiums. */
function usePremiumBars(contract: ScalperChainRow | null, setBars: (value: ChartBar[] | ((current: ChartBar[]) => ChartBar[])) => void) {
  const contractSymbol = contract?.symbol ?? "";
  useEffect(() => {
    if (!contractSymbol) { setBars([]); return; }
    let cancelled = false;
    setBars([]);
    const loadBars = () => fetch(`/api/market-data/option-history?symbol=${encodeURIComponent(contractSymbol)}&timeframe=1m`, { cache: "no-store" })
      .then((response) => response.json()).then((body) => { if (!cancelled && Array.isArray(body.candles)) setBars((current) => { const tail = current.filter((bar) => bar.time > (body.candles.at(-1)?.time ?? Infinity)); return [...body.candles, ...tail]; }); })
      .catch(() => undefined);
    void loadBars();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadBars(); }, 120_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [contractSymbol]);
  const premium = contract?.premium ?? 0;
  useEffect(() => { if (premium > 0) setBars((current) => foldTick(current, premium, 1)); }, [premium]);
}

function ScalperDeskView({ symbol, onSymbolChange, chain, expiry, spot, onLog, onAutoChange, refreshSignal = 0, vwapScalp = null, onPlaceVwapScalp }: {
  symbol: string;
  onSymbolChange: (next: string) => void;
  chain: ScalperChainRow[];
  expiry: string | null;
  spot: number;
  onLog?: (text: string, type?: "entry" | "exit" | "info") => void;
  onAutoChange?: (enabled: boolean) => void;
  /** Bumped when another panel (the VWAP-EMA scalper) places a position in this book. */
  refreshSignal?: number;
  /** The VWAP-EMA scalper's latest read (criteria, OI-selected premium, plan). */
  vwapScalp?: VwapScalpSignal | null;
  /** Place the confirmed VWAP-EMA scalp in this book (the server re-checks every gate). */
  onPlaceVwapScalp?: (origin: "AUTO" | "MANUAL") => Promise<{ placed: boolean; error?: string }>;
}) {
  const [settings, setSettings] = useState<ScalperSettings>(DEFAULT_SETTINGS);
  const [views, setViews] = useState<View[]>(["CALL", "PUT"]);
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>(1);
  const [instant, setInstant] = useState(true);
  // AUTOMATIC: the engine places its own trades. MANUAL: it only signals; you take the trade.
  const [tradeMode, setTradeMode] = useState<"AUTOMATIC" | "MANUAL">("MANUAL");
  const [engineOn, setEngineOn] = useState(false);
  // Which strategy the engine trades: the VWAP-EMA scalper (all 7 criteria) or the level scalper.
  const [engineStrategy, setEngineStrategy] = useState<EngineStrategy>("VWAP_EMA");
  const vwapMode = engineStrategy === "VWAP_EMA";
  const auto = engineOn && tradeMode === "AUTOMATIC";
  const [showControls, setShowControls] = useState(false);
  const [callOffset, setCallOffset] = useState(0);
  const [putOffset, setPutOffset] = useState(0);
  const [callLots, setCallLots] = useState(1);
  const [putLots, setPutLots] = useState(1);
  const [state, setState] = useState<ScalperState>({ positions: [], closed: [], unrealizedPnl: 0, realizedPnl: 0, tradesToday: 0 });
  const [notice, setNotice] = useState("Paper scalper. Start the engine and choose Automatic (engine trades) or Manual (you take its signals), or trade the cards directly.");
  const [positionsTab, setPositionsTab] = useState<"OPEN" | "CLOSED">("OPEN");
  const [selected, setSelected] = useState<string[]>([]);
  const [spotBars, setSpotBars] = useState<ChartBar[]>([]);
  const [callBars, setCallBars] = useState<ChartBar[]>([]);
  const [putBars, setPutBars] = useState<ChartBar[]>([]);
  const busy = useRef(false);
  const spotBarsRef = useRef<ChartBar[]>([]);
  spotBarsRef.current = spotBars;

  useEffect(() => {
    setSettings(load(SETTINGS_KEY, DEFAULT_SETTINGS));
    const prefs = load(PREFS_KEY, { views: ["CALL", "PUT"] as View[], timeframe: 1, instant: true, tradeMode: "MANUAL" as "AUTOMATIC" | "MANUAL", engineStrategy: "VWAP_EMA" as EngineStrategy });
    setTradeMode(prefs.tradeMode === "AUTOMATIC" ? "AUTOMATIC" : "MANUAL");
    setEngineStrategy(prefs.engineStrategy === "LEVELS" ? "LEVELS" : "VWAP_EMA");
    setViews(prefs.views);
    setTimeframe(TIMEFRAMES.includes(prefs.timeframe as 1) ? prefs.timeframe as 1 : 1);
    setInstant(prefs.instant);
  }, []);
  useEffect(() => { save(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => { save(PREFS_KEY, { views, timeframe, instant, tradeMode, engineStrategy }); }, [views, timeframe, instant, tradeMode, engineStrategy]);
  useEffect(() => { onAutoChange?.(auto); }, [auto, onAutoChange]);

  // ---- strike ladder ------------------------------------------------------------------
  const strikes = useMemo(() => [...new Set(chain.map((row) => row.strike))].sort((a, b) => a - b), [chain]);
  const atmIndex = useMemo(() => {
    if (!strikes.length || !(spot > 0)) return Math.floor(strikes.length / 2);
    let best = 0;
    strikes.forEach((strike, index) => { if (Math.abs(strike - spot) < Math.abs(strikes[best] - spot)) best = index; });
    return best;
  }, [spot, strikes]);
  const rowAt = useCallback((type: "CALL" | "PUT", offset: number) => {
    const strike = strikes[Math.min(Math.max(atmIndex + offset, 0), strikes.length - 1)];
    return chain.find((row) => row.contract === type && row.strike === strike) ?? null;
  }, [atmIndex, chain, strikes]);
  const call = rowAt("CALL", callOffset);
  const put = rowAt("PUT", putOffset);
  const moneyness = (type: "CALL" | "PUT", offset: number) => offset === 0 ? "ATM" : (type === "CALL" ? offset > 0 : offset < 0) ? `OTM ${Math.abs(offset)}` : `ITM ${Math.abs(offset)}`;
  const premiumOf = useCallback((value: string) => chain.find((row) => norm(row.symbol) === norm(value))?.premium, [chain]);

  // VWAP-EMA mode: the card and chart of the trade side follow the strike the scalper picked from
  // the OI data. ▲▼ still move it; the next new pick re-centres it.
  const followed = useRef<string | null>(null);
  const pick = vwapMode ? vwapScalp?.selected ?? null : null;
  useEffect(() => {
    if (!pick || followed.current === pick.symbol || !strikes.length) return;
    const index = strikes.indexOf(pick.strike);
    if (index < 0) return;
    followed.current = pick.symbol;
    (pick.type === "CE" ? setCallOffset : setPutOffset)(index - atmIndex);
  }, [atmIndex, pick, strikes]);

  // ---- data: underlying 1m bars + premium bars for the two selected contracts ----------
  useEffect(() => {
    let cancelled = false;
    const loadSpot = () => fetch(`/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=1m&period=day&date=${istDate()}`, { cache: "no-store" })
      .then((response) => response.json()).then((body) => {
        if (cancelled || !Array.isArray(body.candles) || !body.candles.length) return;
        setSpotBars((current) => {
          const history = (body.candles as ChartBar[]).map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
          const tail = current.filter((bar) => bar.time > history.at(-1)!.time);
          return [...history, ...tail];
        });
      }).catch(() => undefined);
    setSpotBars([]);
    void loadSpot();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadSpot(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol]);
  useEffect(() => { if (spot > 0) setSpotBars((current) => current.length ? foldTick(current, spot, 1) : current); }, [spot]);

  usePremiumBars(call, setCallBars);
  usePremiumBars(put, setPutBars);

  // ---- server calls ---------------------------------------------------------------------
  const apply = useCallback((data: ScalperState, quiet = false) => {
    setState((current) => ({ ...current, ...data, decision: data.decision ?? current.decision, monitor: data.monitor ?? current.monitor }));
    if (data.error) setNotice(data.error);
    else if (data.summary && !quiet) setNotice(data.summary);
  }, []);
  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/scalper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, ...body }) });
    return { ok: response.ok, data: await response.json().catch(() => ({ error: "Scalper unavailable" })) as ScalperState };
  }, [symbol]);

  // Reload the book on index change and whenever another panel placed a position in it: an open
  // position switches the 10-second scan on, which manages its stop, target and time stop.
  useEffect(() => { fetch(`/api/scalper?symbol=${symbol}`, { cache: "no-store" }).then((response) => response.json()).then((data) => apply(data, true)).catch(() => undefined); }, [apply, symbol, refreshSignal]);

  const scan = useCallback(async () => {
    if (busy.current || !chain.length || !(spot > 0)) return;
    busy.current = true;
    try {
      // In VWAP-EMA mode the level engine never enters (it still manages exits); entries come from
      // the VWAP-EMA scalper via onPlaceVwapScalp.
      const { data } = await post({ action: "scan", spot, autoEntries: auto && !vwapMode, settings, contracts: chain, bars: spotBarsRef.current.slice(-240) });
      const before = state.positions.map((position) => position.id);
      apply(data, true);
      if (data.summary) setNotice(data.summary);
      const opened = (data.positions ?? []).filter((position) => !before.includes(position.id) && position.kind !== "MANUAL");
      for (const position of opened) {
        onLog?.(`[Scalper] ${position.kind} ${position.label} @ ${money(position.entry)} · ${position.reason}`, "entry");
        // Bring the engine's contract onto the charts.
        const leg = position.legs.find((item) => item.side === "BUY");
        const index = leg ? strikes.indexOf(leg.strike) : -1;
        if (leg && index >= 0) (leg.contract === "CALL" ? setCallOffset : setPutOffset)(index - atmIndex);
      }
      const exited = (data.closed ?? []).filter((position) => before.includes(position.id));
      for (const position of exited) onLog?.(`[Scalper] exit ${position.label} · ${position.exitReason} · P&L ₹${money(position.realizedPnl)}`, "exit");
    } catch { setNotice("Scalper scan unavailable; retrying"); }
    finally { busy.current = false; }
  }, [apply, atmIndex, auto, chain, onLog, post, settings, spot, state.positions, strikes, vwapMode]);
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const hasOpen = state.positions.length > 0;
  // Scan every 10 s while the engine is on or positions are open, and right after each 1m close.
  useEffect(() => {
    if (!engineOn && !hasOpen) return;
    void scanRef.current();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void scanRef.current(); }, 10_000);
    return () => clearInterval(timer);
  }, [engineOn, tradeMode, hasOpen]);
  const lastBarTime = spotBars.at(-1)?.time;
  useEffect(() => { if (engineOn && lastBarTime) void scanRef.current(); }, [engineOn, lastBarTime]);

  const trade = useCallback(async (action: "buy" | "sell", contract: ScalperChainRow | null, lots: number) => {
    if (!contract) { setNotice("No contract at that strike in the live chain yet."); return; }
    const label = `${action === "buy" ? "BUY" : "SELL"} ${lots} lot(s) ${contract.symbol} @ ~₹${money(contract.premium)}`;
    if (!instant && !window.confirm(`${label}?\nPaper order.`)) return;
    const { data } = await post({ action, contract, lots, contracts: chain });
    apply(data);
    if (!data.error) onLog?.(`[Scalper] ${data.summary ?? label}`, action === "buy" ? "entry" : "exit");
  }, [apply, chain, instant, onLog, post]);
  const takeSignal = useCallback(async () => {
    const signal = state.decision?.plan;
    if (!signal) return;
    if (!instant && !window.confirm(`Take the engine's ${signal.kind} signal?\n${signal.legs.map((leg) => `${leg.side} ${leg.symbol} @ ~₹${money(leg.price)}`).join("\n")}\nSL ${money(signal.stop)} · Target ${money(signal.target)} · ${signal.riskReward}R\nPaper order.`)) return;
    const { data } = await post({ action: "take", contracts: chain, settings });
    apply(data);
    if (!data.error) onLog?.(`[Scalper] ${data.summary}`, "entry");
  }, [apply, chain, instant, onLog, post, settings, state.decision?.plan]);
  // ---- VWAP-EMA scalper entries ------------------------------------------------------------
  const attempted = useRef(new Set<string>());
  const [placing, setPlacing] = useState(false);
  const placeVwap = useCallback(async (origin: "AUTO" | "MANUAL") => {
    if (!onPlaceVwapScalp || !vwapScalp?.confirmed || !vwapScalp.setupId || placing) return;
    if (origin === "MANUAL" && !instant && !window.confirm(`Take the VWAP-EMA scalp?\nBUY ${vwapScalp.selected?.symbol} · SL ₹${money(vwapScalp.plan?.stop)} · Target ₹${money(vwapScalp.plan?.target)} (${vwapScalp.plan?.rrChoice})\nPaper order.`)) return;
    attempted.current.add(vwapScalp.setupId);
    setPlacing(true);
    try {
      const result = await onPlaceVwapScalp(origin);
      setNotice(result.placed ? `VWAP-EMA scalp ${origin === "AUTO" ? "auto-placed" : "placed"}: BUY ${vwapScalp.selected?.symbol} · SL ₹${money(vwapScalp.plan?.stop)} · T ₹${money(vwapScalp.plan?.target)}. Stop trails: breakeven at +0.5R, +0.5R locked at +1R, then 0.6R under the best premium.` : `VWAP-EMA scalp not placed: ${result.error ?? "refused"}`);
    } finally { setPlacing(false); }
  }, [instant, onPlaceVwapScalp, placing, vwapScalp]);
  useEffect(() => {
    if (vwapMode && auto && vwapScalp?.confirmed && vwapScalp.setupId && !attempted.current.has(vwapScalp.setupId)) void placeVwap("AUTO");
  }, [auto, placeVwap, vwapMode, vwapScalp]);
  const vwapReady = Boolean(vwapScalp?.confirmed && vwapScalp.setupId && !attempted.current.has(vwapScalp.setupId));

  const exit = useCallback(async (ids: string[] | "ALL") => {
    if (!instant && !window.confirm(ids === "ALL" ? "Exit all scalper positions?" : `Exit ${ids.length} position(s)?`)) return;
    const { data } = await post(ids === "ALL" ? { action: "exitAll", contracts: chain } : { action: "exit", ids, contracts: chain });
    apply(data);
    setSelected([]);
    if (data.summary) onLog?.(`[Scalper] ${data.summary}`, "exit");
  }, [apply, chain, instant, onLog, post]);

  // Shift+↑ buy call · Shift+← sell call · Shift+↓ buy put · Shift+→ sell put.
  const tradeRef = useRef({ trade, call, put, callLots, putLots });
  tradeRef.current = { trade, call, put, callLots, putLots };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const current = tradeRef.current;
      const map: Record<string, () => void> = {
        ArrowUp: () => void current.trade("buy", current.call, current.callLots),
        ArrowLeft: () => void current.trade("sell", current.call, current.callLots),
        ArrowDown: () => void current.trade("buy", current.put, current.putLots),
        ArrowRight: () => void current.trade("sell", current.put, current.putLots),
      };
      if (map[event.key]) { event.preventDefault(); map[event.key](); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- live marks ------------------------------------------------------------------------
  const livePositions = useMemo(() => state.positions.map((position) => {
    const legs = position.legs.map((leg) => ({ ...leg, ltp: premiumOf(leg.symbol) ?? leg.ltp }));
    const value = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? leg.ltp : -leg.ltp), 0);
    return { ...position, legs, value, pnl: (value - position.entry) * position.quantity };
  }), [premiumOf, state.positions]);
  const unrealized = livePositions.reduce((sum, position) => sum + position.pnl, 0);
  const overall = unrealized + state.realizedPnl;
  const decision = state.decision;

  const levelsFor = useCallback((contractSymbol: string | undefined): ChartLevel[] => {
    const position = livePositions.find((item) => item.legs.length === 1 && norm(item.legs[0].symbol) === norm(contractSymbol));
    if (!position) return [];
    // With a risk-reward drawing (stop and target both set) the zones carry the labels; the lines
    // keep only their price tags so the two never overlap.
    const drawn = position.stop !== null && position.target !== null;
    return [
      { price: position.entry, color: "#5aa9ff", title: drawn ? "" : "Avg" },
      ...(position.stop ? [{ price: position.stop, color: "#fa6b78", title: drawn ? "" : position.trailing ? "Trail SL" : "SL", dashed: true }] : []),
      ...(position.target ? [{ price: position.target, color: "#22d59b", title: drawn ? "" : "Target", dashed: true }] : []),
    ];
  }, [livePositions]);
  const spotLevels = useMemo<ChartLevel[]>(() => {
    const read = decision?.read;
    const levels: ChartLevel[] = [];
    for (const level of read?.supports.slice(0, 3) ?? []) levels.push({ price: level.price, color: "rgba(34,213,155,.8)", title: `S ${level.sources[0] ?? ""}`, dashed: true });
    for (const level of read?.resistances.slice(0, 3) ?? []) levels.push({ price: level.price, color: "rgba(250,107,120,.8)", title: `R ${level.sources[0] ?? ""}`, dashed: true });
    const plan = decision?.plan?.spot ?? livePositions.find((position) => position.spot)?.spot;
    if (plan) levels.push({ price: plan.stop, color: "#fa6b78", title: "Spot SL" }, { price: plan.target, color: "#22d59b", title: "Spot T" });
    return levels;
  }, [decision, livePositions]);
  const callLevels = useMemo(() => levelsFor(call?.symbol), [call?.symbol, levelsFor]);
  const putLevels = useMemo(() => levelsFor(put?.symbol), [put?.symbol, levelsFor]);
  // Risk-reward drawing: the open position's live zones (the SL moves as it trails), else the
  // VWAP-EMA plan on the contract it picked.
  const boxFor = useCallback((contractSymbol: string | undefined): RiskRewardBox | null => {
    const position = livePositions.find((item) => item.legs.length === 1 && norm(item.legs[0].symbol) === norm(contractSymbol) && item.stop !== null && item.target !== null);
    if (position) return { entry: position.entry, stop: position.stop!, target: position.target!, fromTime: epochOf(position.openedAt), quantity: position.quantity, label: `${position.kind} ${position.trail ? "VWAP-EMA" : ""}`.trim(), stopTitle: position.trail ? `SL · ${TRAIL_TEXT[position.trail.stage]}` : position.trailing ? "Trail SL" : "SL" };
    if (vwapMode && vwapScalp?.plan && vwapScalp.selected && norm(vwapScalp.selected.symbol) === norm(contractSymbol) && vwapScalp.plan.stop < vwapScalp.plan.entry && vwapScalp.plan.target > vwapScalp.plan.entry) {
      return { entry: vwapScalp.plan.entry, stop: vwapScalp.plan.stop, target: vwapScalp.plan.target, fromTime: epochOf(vwapScalp.triggerTime), quantity: vwapScalp.plan.quantity, label: vwapScalp.confirmed ? `Signal ${vwapScalp.plan.rrChoice}` : `Plan ${vwapScalp.plan.rrChoice} (not confirmed)` };
    }
    return null;
  }, [livePositions, vwapMode, vwapScalp]);
  const callBox = useMemo(() => boxFor(call?.symbol), [boxFor, call?.symbol]);
  const putBox = useMemo(() => boxFor(put?.symbol), [boxFor, put?.symbol]);
  const tfBars = useCallback((bars: ChartBar[]) => regroupBars(bars, timeframe), [timeframe]);

  const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
  const chartHead = (contract: ScalperChainRow | null, bars: ChartBar[], lots: number) => {
    const last = bars.at(-1);
    const first = bars.find((bar) => istDate() === new Date((bar.time + 19_800) * 1000).toISOString().slice(0, 10)) ?? bars[0];
    const change = last && first ? last.close - first.open : 0;
    return (
      <div className="scalper-chart-head">
        <div>
          <b>{contract ? `${symbol} ${expiryLabel(contract.expiry || expiry)} ${contract.strike} ${contract.contract === "CALL" ? "Call" : "Put"}` : "No contract"} · {timeframe} · {exchange}</b>
          {last ? <small>O<em>{money(last.open)}</em> H<em>{money(last.high)}</em> L<em>{money(last.low)}</em> C<em>{money(last.close)}</em> <span className={change >= 0 ? "gain" : "loss"}>{change >= 0 ? "+" : ""}{money(change)} ({first?.open ? money((change / first.open) * 100) : "--"}%)</span></small> : <small>Waiting for premium candles…</small>}
        </div>
        {contract ? (
          <div className="scalper-quote">
            <button type="button" className="scalper-quote-sell" onClick={() => void trade("sell", contract, lots)}><b>{money(contract.bid || contract.premium)}</b><small>SELL</small></button>
            <span><small>{money(Math.max((contract.ask || contract.premium) - (contract.bid || contract.premium), 0))}</small><b>{lots * (contract.lotSize || 1)}</b></span>
            <button type="button" className="scalper-quote-buy" onClick={() => void trade("buy", contract, lots)}><b>{money(contract.ask || contract.premium)}</b><small>BUY</small></button>
          </div>
        ) : null}
      </div>
    );
  };

  const optionCard = (type: "CALL" | "PUT", contract: ScalperChainRow | null, offset: number, setOffset: (fn: (value: number) => number) => void, lots: number, setLots: (fn: (value: number) => number) => void) => {
    const qty = lots * (contract?.lotSize || 1);
    const label = type === "CALL" ? "Call" : "Put";
    return (
      <div className={`scalper-card scalper-card-${type.toLowerCase()}`}>
        <div className="scalper-card-head">
          <span className="scalper-strike">
            <b>{contract?.strike ?? "--"} {type}</b> <em>{moneyness(type, offset)}</em>{pick && contract && norm(pick.symbol) === norm(contract.symbol) ? <em className="scalper-oi-pick" title="Strike picked by the VWAP-EMA scalper from OI, volume and build-up (delta 0.40-0.60)">OI pick</em> : null}
            <button type="button" aria-label={`Higher ${label} strike`} onClick={() => setOffset((value) => Math.min(value + 1, strikes.length - 1 - atmIndex))}>▲</button>
            <button type="button" aria-label={`Lower ${label} strike`} onClick={() => setOffset((value) => Math.max(value - 1, -atmIndex))}>▼</button>
          </span>
          <b>₹{money(contract?.premium)}</b>
        </div>
        <div className="scalper-card-meta">
          <span><small>Cost</small><b>₹{money(contract ? contract.premium * qty : null)}</b></span>
          <span className="scalper-lots"><small>Lots</small>
            <span><button type="button" aria-label={`Fewer ${label} lots`} onClick={() => setLots((value) => Math.max(1, value - 1))}>−</button><b>{lots}</b><button type="button" aria-label={`More ${label} lots`} onClick={() => setLots((value) => Math.min(50, value + 1))}>+</button></span>
          </span>
          <span><small>{qty} qty</small><b>Δ {contract?.delta ? money(contract.delta, 2) : "--"} · θ {contract?.theta ? money(contract.theta, 1) : "--"}</b></span>
        </div>
        <div className="scalper-card-actions">
          <button type="button" className="scalper-buy" onClick={() => void trade("buy", contract, lots)}>⚡ Buy {label}</button>
          <button type="button" className="scalper-sell" onClick={() => void trade("sell", contract, lots)}>⚡ Sell {label}</button>
        </div>
        <div className="scalper-keys"><kbd>Shift {type === "CALL" ? "↑" : "↓"}</kbd><kbd>Shift {type === "CALL" ? "←" : "→"}</kbd></div>
      </div>
    );
  };

  const toggleView = (view: View) => setViews((current) => current.includes(view) ? (current.length > 1 ? current.filter((item) => item !== view) : current) : (["CALL", "SPOT", "PUT"] as View[]).filter((item) => item === view || current.includes(item)));
  const shownPositions = positionsTab === "OPEN" ? livePositions : state.closed;
  const plan = decision?.plan;

  return (
    <section className="scalper" aria-label="Smart scalper">
      <div className="scalper-main">
        <div className="scalper-toolbar">
          <span className="scalper-title">⚡ Scalper <small>paper</small></span>
          <select aria-label="Chart timeframe" value={timeframe} onChange={(event) => setTimeframe(Number(event.target.value) as 1)}>{TIMEFRAMES.map((value) => <option key={value} value={value}>{value}m</option>)}</select>
          <span className="scalper-views">{(["CALL", "SPOT", "PUT"] as View[]).map((view) => <button key={view} type="button" className={views.includes(view) ? "on" : ""} onClick={() => toggleView(view)}>{view}</button>)}</span>
          <button type="button" className="scalper-controls-button" onClick={() => setShowControls((value) => !value)}>⚙ Controls</button>
          <label className="scalper-switch"><input type="checkbox" checked={instant} onChange={(event) => setInstant(event.target.checked)} /><span /> Instant mode</label>
        </div>

        <div className="scalper-engine-bar" role="group" aria-label="Auto option engine">
          <span className="algo-kicker">AUTO OPTION ENGINE · PAPER</span>
          <select aria-label="Engine strategy" className="scalper-strategy" value={engineStrategy} onChange={(event) => { const next = event.target.value as EngineStrategy; setEngineStrategy(next); setNotice(next === "VWAP_EMA" ? "VWAP-EMA scalper: enters only when all 7 criteria and every V5 gate pass (the server re-checks). SL, target and a staged trail are set systematically." : "Level scalper: CE at support rejections, PE at resistance rejections; spreads in volatile tape."); }}>
            <option value="VWAP_EMA">Strategy: VWAP-EMA scalper</option>
            <option value="LEVELS">Strategy: Level scalper</option>
          </select>
          <label className="scalper-switch scalper-switch-auto"><input type="checkbox" checked={engineOn} onChange={(event) => { setEngineOn(event.target.checked); setNotice(event.target.checked ? `Engine on (${tradeMode === "AUTOMATIC" ? "automatic: it places its own trades" : "manual: it signals, you take the trade"}). Scanning the 1m tape.` : "Engine off: open positions are still managed."); }} /><span /> Engine</label>
          <span className="scalper-trade-mode" role="radiogroup" aria-label="Trade selection">
            <small>Trade</small>
            {(["AUTOMATIC", "MANUAL"] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={tradeMode === value} className={tradeMode === value ? "on" : ""} onClick={() => { setTradeMode(value); setNotice(value === "AUTOMATIC" ? "Automatic: the engine enters its own signals within your risk limits." : "Manual: the engine only signals; press Take trade to enter, or use the Buy/Sell cards."); }}>{value === "AUTOMATIC" ? "Automatic" : "Manual"}</button>
            ))}
          </span>
          {engineOn && tradeMode === "MANUAL" && !vwapMode ? <button type="button" className="scalper-take" disabled={!plan || !state.signalReady} onClick={() => void takeSignal()} title={plan && state.signalReady ? "Enter the engine's current signal" : "No signal yet"}>⚡ Take trade{plan && state.signalReady ? ` · ${plan.side} ${plan.kind.toLowerCase()} ${plan.riskReward}R` : ""}</button> : null}
          {engineOn && tradeMode === "MANUAL" && vwapMode ? <button type="button" className="scalper-take" disabled={!vwapReady || placing} onClick={() => void placeVwap("MANUAL")} title={vwapReady ? "Place the confirmed VWAP-EMA scalp (server re-checks every gate)" : "Waiting for all 7 criteria"}>⚡ Take trade{vwapReady && vwapScalp?.selected ? ` · BUY ${vwapScalp.selected.strike} ${vwapScalp.selected.type} ${vwapScalp.plan?.rrChoice ?? ""}` : ""}</button> : null}
        </div>

        {showControls && (
          <div className="scalper-controls">
            <label>Engine mode<select value={settings.mode} onChange={(event) => setSettings((current) => ({ ...current, mode: event.target.value as ScalperSettings["mode"] }))}><option value="AUTO">Auto (scalp or hedge)</option><option value="SCALP">Scalp only</option><option value="HEDGE">Hedge only</option></select></label>
            <label>Max trades / day<select value={settings.maxTrades} onChange={(event) => setSettings((current) => ({ ...current, maxTrades: Number(event.target.value) }))}>{[1, 2, 3, 4, 5, 6, 8, 10].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Max loss / trade<select value={settings.maxLossPerTrade} onChange={(event) => setSettings((current) => ({ ...current, maxLossPerTrade: Number(event.target.value) }))}>{[500, 1000, 1500, 2000, 2500, 5000].map((value) => <option key={value} value={value}>₹{value.toLocaleString("en-IN")}</option>)}</select></label>
            <label>Daily loss stop<select value={settings.maxDailyLoss} onChange={(event) => setSettings((current) => ({ ...current, maxDailyLoss: Number(event.target.value) }))}>{[1500, 3000, 4000, 5000, 7500, 10000].map((value) => <option key={value} value={value}>₹{value.toLocaleString("en-IN")}</option>)}</select></label>
            <label>Lots cap<select value={settings.lots} onChange={(event) => setSettings((current) => ({ ...current, lots: Number(event.target.value) }))}>{[1, 2, 3, 4, 5, 10].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Min reward : risk<select value={settings.minRiskReward} onChange={(event) => setSettings((current) => ({ ...current, minRiskReward: Number(event.target.value) }))}>{[1.5, 2, 2.5, 3].map((value) => <option key={value} value={value}>{value} R</option>)}</select></label>
            <label>Scalp time stop<select value={settings.maxHoldMinutes} onChange={(event) => setSettings((current) => ({ ...current, maxHoldMinutes: Number(event.target.value) }))}>{[5, 8, 12, 15, 20, 30].map((value) => <option key={value} value={value}>{value} min</option>)}</select></label>
          </div>
        )}

        {vwapMode ? (
          <div className={`scalper-engine ${vwapScalp?.confirmed ? "scalper-engine-live" : ""}`}>
            <span className={`scalper-mode scalper-mode-${vwapScalp?.confirmed ? "scalp" : "wait"}`}>{engineOn ? `VWAP-EMA · ${vwapScalp?.confirmed ? "CONFIRMED" : "WAITING"} · ${tradeMode === "AUTOMATIC" ? "AUTO" : "MANUAL"}` : "ENGINE OFF"}</span>
            {vwapScalp?.side ? <span className={vwapScalp.side === "CE" ? "scalper-side gain" : "scalper-side loss"}>{vwapScalp.side === "CE" ? "CE · long" : "PE · short"}</span> : null}
            {vwapScalp ? <span className="scalper-read">criteria {vwapScalp.criteriaMet}/{vwapScalp.criteriaTotal}{vwapScalp.waitingOn.length ? ` · waiting on ${vwapScalp.waitingOn.join(", ")}` : ""}{vwapScalp.selected ? ` · OI pick ${vwapScalp.selected.strike} ${vwapScalp.selected.type}` : ""}</span> : <span className="scalper-read">waiting for the VWAP-EMA engine…</span>}
            <p>{notice}</p>
            {vwapScalp?.plan ? (
              <div className="scalper-plan">
                <b>{vwapScalp.confirmed ? "Signal" : "Plan (not confirmed)"} · BUY {vwapScalp.selected?.symbol} · {vwapScalp.plan.rrChoice}{vwapScalp.plan.riskReward ? ` = ${vwapScalp.plan.riskReward}R on the premium` : ""}{vwapScalp.plan.netRiskReward ? ` (${vwapScalp.plan.netRiskReward}R after charges)` : ""}</b>
                <span>Entry ₹{money(vwapScalp.plan.entry)} · SL ₹{money(vwapScalp.plan.stop)} · Target ₹{money(vwapScalp.plan.target)}{vwapScalp.plan.quantity ? ` · ${vwapScalp.plan.quantity} qty` : ""}</span>
                <span>Trailing: SL to breakeven + charges at +0.5R · lock +0.5R at +1R · then 0.6R under the best premium · exit if a 1m candle closes back through the 9 EMA</span>
                <span>On placing: re-planned on the actual fill (refused if it drifts past tolerance or the R:R drops); sized on the stressed loss (stop gap + slippage on both legs). Exits run on the server.</span>
              </div>
            ) : null}
            <small className="mi-note">{vwapScalp?.reason ?? ""}</small>
          </div>
        ) : (
        <div className={`scalper-engine ${decision?.mode === "WAIT" || !decision ? "" : "scalper-engine-live"}`}>
          <span className={`scalper-mode scalper-mode-${(decision?.mode ?? "WAIT").toLowerCase()}`}>{engineOn ? `${decision?.mode ?? "SCANNING"} · ${tradeMode === "AUTOMATIC" ? "AUTO" : "MANUAL"}` : "ENGINE OFF"}</span>
          {decision?.side ? <span className={decision.side === "CE" ? "scalper-side gain" : "scalper-side loss"}>{decision.side === "CE" ? "CE · bullish" : "PE · bearish"}</span> : null}
          {decision?.read ? <span className="scalper-read">{decision.read.regime} · {decision.read.trend} · ATR {money(decision.read.atr)} · RSI {money(decision.read.rsi, 0)}{decision.daysToExpiry !== null ? ` · ${decision.daysToExpiry === 0 ? "expiry day" : `${decision.daysToExpiry}d to expiry`}` : ""}</span> : null}
          <p>{notice}</p>
          {decision && (
            <details>
              <summary>Why this decision</summary>
              <ul>{decision.reasons.map((line) => <li key={line}>{line}</li>)}</ul>
              {decision.gates.length ? <div className="scalper-gates">{decision.gates.map((gate) => <span key={gate.label} className={gate.passed ? "pass" : "fail"}>{gate.passed ? "✓" : "✗"} {gate.label}</span>)}</div> : null}
              {plan ? (
                <div className="scalper-plan">
                  <b>{plan.kind} plan · {plan.lots} lot(s) · {plan.quantity} qty · {plan.riskReward}R</b>
                  <span>Entry {money(plan.entry)} · SL {money(plan.stop)} · Target {money(plan.target)} · risk ₹{money(plan.riskPerLot, 0)}/lot · reward ₹{money(plan.rewardPerLot, 0)}/lot</span>
                  <span>Spot entry {money(plan.spot.entry)} · invalidation {money(plan.spot.stop)} · target {money(plan.spot.target)}</span>
                  {plan.legs.map((leg) => <span key={leg.symbol}>{leg.side} {leg.symbol} @ {money(leg.price)} · {leg.valuation.moneyness} · intrinsic {money(leg.valuation.intrinsic)} ({leg.valuation.intrinsicPct}%) · time value {money(leg.valuation.timeValue)} · θ {money(leg.valuation.theta, 1)}</span>)}
                </div>
              ) : null}
            </details>
          )}
        </div>
        )}

        <div className="scalper-charts" style={{ gridTemplateColumns: `repeat(${views.length}, minmax(0, 1fr))` }}>
          {views.includes("CALL") && <div className="scalper-chart">{chartHead(call, callBars, callLots)}<PremiumChart bars={tfBars(callBars)} levels={callLevels} riskReward={callBox} /></div>}
          {views.includes("SPOT") && (
            <div className="scalper-chart">
              <div className="scalper-chart-head"><div><b>{symbol} spot · {timeframe} · {exchange}</b><small>LTP <em>{money(spot)}</em> · supports green, resistances red (1m engine levels)</small></div></div>
              <PremiumChart bars={tfBars(spotBars)} levels={spotLevels} />
            </div>
          )}
          {views.includes("PUT") && <div className="scalper-chart">{chartHead(put, putBars, putLots)}<PremiumChart bars={tfBars(putBars)} levels={putLevels} riskReward={putBox} /></div>}
        </div>

        <div className="scalper-cards">
          {optionCard("CALL", call, callOffset, setCallOffset, callLots, setCallLots)}
          <div className="scalper-center">
            <div className="scalper-index">
              <select aria-label="Index" value={symbol} onChange={(event) => onSymbolChange(event.target.value)}>{INDICES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <span className="scalper-expiry">{expiryLabel(expiry)}</span>
            </div>
            <small>{symbol} P&amp;L</small>
            <b className={overall >= 0 ? "gain" : "loss"}>{signed(overall)}</b>
            <button type="button" className="scalper-exit-all" disabled={!livePositions.length} onClick={() => void exit("ALL")}>⚡ Exit all</button>
          </div>
          {optionCard("PUT", put, putOffset, setPutOffset, putLots, setPutLots)}
        </div>
      </div>

      <aside className="scalper-side-panel">
        <div className="scalper-tabs">
          <button type="button" className={positionsTab === "OPEN" ? "on" : ""} onClick={() => setPositionsTab("OPEN")}>Positions ({livePositions.length})</button>
          <button type="button" className={positionsTab === "CLOSED" ? "on" : ""} onClick={() => setPositionsTab("CLOSED")}>Closed ({state.closed.length})</button>
        </div>
        <div className="scalper-pnl">
          <small>Overall P&amp;L ({livePositions.length + state.closed.length})</small>
          <b className={overall >= 0 ? "gain" : "loss"}>{signed(overall)}</b>
          <span><small>Unrealised P&amp;L</small><em className={unrealized >= 0 ? "gain" : "loss"}>{signed(unrealized)}</em></span>
          <span><small>Realised P&amp;L</small><em className={state.realizedPnl >= 0 ? "gain" : "loss"}>{signed(state.realizedPnl)}</em></span>
          <span><small>Engine trades today</small><em>{state.tradesToday}/{settings.maxTrades}</em></span>
          <span title="Stops, targets, the trail, time stops and the 15:15 square-off run on the server, with or without this page open"><small>Exit monitor (server)</small><em className={state.monitor?.running && !state.monitor.lastError ? "gain" : "loss"}>{state.monitor ? (state.monitor.running ? `${state.monitor.lastError ? "error" : "running"}${state.monitor.lastTickAt ? ` · ${new Date(state.monitor.lastTickAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}` : ""}` : "stopped") : "--"}</em></span>
        </div>
        {positionsTab === "OPEN" && selected.length > 0 && <button type="button" className="scalper-exit-selected" onClick={() => void exit(selected)}>Exit selected ({selected.length})</button>}
        <div className="scalper-positions">
          {shownPositions.length ? shownPositions.map((position) => (
            <div key={position.id} className="scalper-position">
              <label>
                {positionsTab === "OPEN" ? <input type="checkbox" checked={selected.includes(position.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, position.id] : current.filter((id) => id !== position.id))} /> : null}
                <b>{position.label}</b>
              </label>
              <em className={position.pnl >= 0 ? "gain" : "loss"}>{signed(positionsTab === "OPEN" ? position.pnl : position.realizedPnl ?? 0)}</em>
              <small>Mkt ₹{money(position.value)} · Avg ₹{money(position.entry)} · {position.kind}{position.legs.length > 1 ? " · spread" : ""}{position.exitReason ? ` · ${position.exitReason}` : ""}</small>
              <small className="scalper-qty">{positionsTab === "OPEN" ? position.quantity : 0}</small>
              {positionsTab === "OPEN" ? <button type="button" title="Exit this position" onClick={() => void exit([position.id])}>✕</button> : null}
              {position.stop !== null && positionsTab === "OPEN" ? <small className="scalper-levels">SL ₹{money(position.stop)}{position.trail ? ` (${TRAIL_TEXT[position.trail.stage]})` : position.trailing ? " (trailing)" : ""} · T ₹{money(position.target)}</small> : null}
              {position.fill && positionsTab === "OPEN" ? <small className="scalper-levels">Filled ₹{money(position.fill.actual)} (planned ₹{money(position.fill.planned)}, {position.fill.deviation >= 0 ? "+" : ""}{money(position.fill.deviation)}) · {position.fill.riskReward}R at the fill · max loss ₹{money(position.fill.plannedLoss, 0)} planned / ₹{money(position.fill.stressedLoss, 0)} stressed</small> : null}
            </div>
          )) : <div className="algo-empty">{positionsTab === "OPEN" ? "No open scalper positions." : "No closed trades today."}</div>}
        </div>
        <p className="scalper-footnote">{vwapMode ? "VWAP-EMA entries: all 7 criteria (VWAP, 5/9 EMA trigger, delta 0.40-0.60, OI, PCR, premium volume profile, India VIX) and every V5 gate, re-checked on the server. The strike is picked from OI. SL and target come from the index stop via delta and gamma; the SL trails to breakeven + charges at +0.5R, locks +0.5R at +1R, then trails 0.6R; a 1m close back through the 9 EMA exits. " : ""}Level engine entries: CE only when the 1m candle tags a support and rejects it; PE only at a resistance (where the put premium is at its own support). Each trade needs {settings.minRiskReward}R of room to the next level and risks at most ₹{settings.maxLossPerTrade.toLocaleString("en-IN")}. Volatile tape, rich IV or expiry afternoon switch it to a debit-spread hedge. Sell only closes a long; no naked writing. Paper only.</p>
      </aside>
    </section>
  );
}

/** Memoised: the algo page re-renders on every quote flush; this panel only when its own props change. */
export const ScalperDesk = memo(ScalperDeskView);
