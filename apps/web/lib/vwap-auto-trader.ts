import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { getScalper } from "./scalper-instance";
import { entryOpen, entryWindowLabel } from "./underlyings";
import type { PositionView, ScalperSettings } from "../../../services/paper-trading/src/smart-scalper";

/**
 * Server-side auto-execution of the selected strategy onto the paper Smart Scalper: the VWAP-EMA-ADX
 * scalper (VWAP_EMA_SCALP, NIFTY / BANKNIFTY / SENSEX) or NIFTY Sniper AI (NIFTY_SNIPER, NIFTY only).
 *
 * When it is switched on for an index, the Node server re-runs the strategy and every V5 gate a few
 * seconds after each 1-minute close (POST /api/algo-trading PLACE_ON_SCALPER, the same path as the
 * "Place on Scalper" button) and places a CONFIRMED setup, with or without a browser open.
 *
 * One trade at a time: while a VWAP-EMA trade is open on any index the trader does not even run the
 * strategy, and SmartScalper.place() refuses a new entry anyway. The next entry is allowed once that
 * trade has exited (target, SL or trailing SL, or a time / momentum / 15:15 / manual exit).
 *
 * Everything the placement path already enforces still applies: the kill switch, SAFE_MODE, daily
 * risk, broker health, the trade cap, the loss cool-down, each underlying's session (09:15-15:15 IST index options, 09:20-22:45 IST MCX). Paper only.
 */

export type AutoStrategy = "VWAP_EMA_SCALP" | "NIFTY_SNIPER";
export const AUTO_STRATEGY_NAMES: Record<AutoStrategy, string> = { VWAP_EMA_SCALP: "VWAP-EMA", NIFTY_SNIPER: "NIFTY Sniper AI" };
export type AutoTraderConfig = { enabled: boolean; strategy: AutoStrategy; indices: string[]; riskReward: "1:1" | "1:2"; settings: Partial<ScalperSettings>; updatedAt: string | null };
export type AutoTraderEvent = { at: string; index: string; status: "PLACED" | "WAITING" | "BLOCKED" | "IN_TRADE" | "CLOSED" | "ERROR"; text: string };
export type AutoTraderDeps = {
  /** Run the strategy and place a confirmed setup; mirrors POST /api/algo-trading PLACE_ON_SCALPER. */
  place(input: { underlying: string; riskReward: string; settings: Partial<ScalperSettings>; strategy: AutoStrategy }): Promise<{ status: number; body: Record<string, unknown> }>;
  openTrade(): Promise<PositionView | null>;
  now(): number;
  load(): Promise<Partial<AutoTraderConfig> | null>;
  save(config: AutoTraderConfig): Promise<void>;
};

type State = {
  config: AutoTraderConfig; loaded: boolean; timer: ReturnType<typeof setTimeout> | null; busy: boolean; origin: string; deps: AutoTraderDeps | null;
  lastRunAt: string | null; nextRunAt: string | null; lastPlacedAt: string | null; openTrade: PositionView | null; events: AutoTraderEvent[]; lastByIndex: Record<string, AutoTraderEvent>;
};

// Index options and MCX commodity options; each is traded inside its own session (lib/underlyings).
const INDICES = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "GOLD"]);
const STRATEGY_INDICES: Record<AutoStrategy, Set<string>> = { VWAP_EMA_SCALP: INDICES, NIFTY_SNIPER: new Set(["NIFTY"]) };
const strategyOf = (value: unknown): AutoStrategy => (value === "NIFTY_SNIPER" ? "NIFTY_SNIPER" : "VWAP_EMA_SCALP");
const CONFIG_DOC = ["settings", "vwapAutoTrader"] as const;
/** Seconds after each minute's close: the 1-minute candle has to be complete in the feed. */
const AFTER_CLOSE_MS = 6_000;
const EMPTY: AutoTraderConfig = { enabled: false, strategy: "VWAP_EMA_SCALP", indices: [], riskReward: "1:2", settings: {}, updatedAt: null };

const holder = globalThis as typeof globalThis & { __tradepulseVwapAutoTrader?: State };
const state = (holder.__tradepulseVwapAutoTrader ??= {
  config: { ...EMPTY }, loaded: false, timer: null, busy: false, origin: "", deps: null,
  lastRunAt: null, nextRunAt: null, lastPlacedAt: null, openTrade: null, events: [], lastByIndex: {},
});

function defaultDeps(): AutoTraderDeps {
  return {
    place: async (input) => {
      // contracts are omitted: the route reads the live chain itself.
      const response = await fetch(`${state.origin}/api/algo-trading`, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(55_000),
        body: JSON.stringify({ action: "PLACE_ON_SCALPER", underlying: input.underlying, riskReward: input.riskReward, settings: input.settings, strategy: input.strategy, origin: "AUTO_TRADER" }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    },
    openTrade: () => getScalper().currentEngineTrade(),
    now: () => Date.now(),
    load: async () => { const snapshot = await getDoc(doc(db, ...CONFIG_DOC)); return snapshot.exists() ? snapshot.data() as Partial<AutoTraderConfig> : null; },
    save: async (config) => { await setDoc(doc(db, ...CONFIG_DOC), config); },
  };
}
const deps = () => (state.deps ??= defaultDeps());

function record(event: Omit<AutoTraderEvent, "at">) {
  const full = { ...event, at: new Date(deps().now()).toISOString() };
  state.lastByIndex[event.index] = full;
  // Repeated "waiting" lines for the same reason are not news: keep the log to changes.
  const last = state.events[0];
  if (!(last && last.index === full.index && last.status === full.status && last.text === full.text)) state.events = [full, ...state.events].slice(0, 30);
}

const sanitize = (raw: Partial<AutoTraderConfig> | null | undefined): AutoTraderConfig => {
  const strategy = strategyOf(raw?.strategy);
  const allowed = STRATEGY_INDICES[strategy];
  const indices = [...new Set((Array.isArray(raw?.indices) ? raw!.indices : []).map((item) => String(item).toUpperCase()).filter((item) => allowed.has(item)))];
  return { enabled: Boolean(raw?.enabled) && indices.length > 0, strategy, indices, riskReward: raw?.riskReward === "1:1" ? "1:1" : "1:2", settings: raw?.settings && typeof raw.settings === "object" ? raw.settings : {}, updatedAt: raw?.updatedAt ?? null };
};

async function ensureLoaded() {
  if (state.loaded) return;
  state.loaded = true;
  try { state.config = sanitize(await deps().load()); } catch { state.config = { ...EMPTY }; }
}

/** One pass: skip outside hours or while a trade is open; else try each watched index until one places. Public for tests. */
export async function vwapAutoTraderTick() {
  if (state.busy) return { skipped: "busy" as const };
  state.busy = true;
  try {
    await ensureLoaded();
    const { config } = state;
    state.lastRunAt = new Date(deps().now()).toISOString();
    if (!config.enabled || !config.indices.length) return { skipped: "off" as const };
    // Each underlying has its own entry window (index options 09:15-15:15, MCX 09:20-22:45).
    const now = deps().now();
    const tradable = config.indices.filter((index) => entryOpen(index, now));
    for (const index of config.indices.filter((item) => !tradable.includes(item))) record({ index, status: "BLOCKED", text: `Market closed for new entries (${entryWindowLabel(index)} on trading days)` });
    if (!tradable.length) return { skipped: "hours" as const };
    const before = state.openTrade;
    const open = await deps().openTrade();
    state.openTrade = open;
    const name = AUTO_STRATEGY_NAMES[config.strategy];
    if (before && !open) record({ index: before.underlying, status: "CLOSED", text: `${before.label} exited: the next ${name} entry is allowed` });
    if (open) {
      record({ index: open.underlying, status: "IN_TRADE", text: `BUY ${open.label} open (SL ₹${open.stop ?? "--"} · T ₹${open.target ?? "--"}): no new trade until it exits at its target, SL or trailing SL` });
      return { skipped: "in-trade" as const };
    }
    for (const index of tradable) {
      const result = await deps().place({ underlying: index, riskReward: config.riskReward, settings: config.settings, strategy: config.strategy }).catch((error: unknown) => ({ status: 0, body: { error: error instanceof Error ? error.message : "request failed" } as Record<string, unknown> }));
      const body = result.body;
      if (result.status === 200 && body.placed) {
        state.lastPlacedAt = new Date(deps().now()).toISOString();
        state.openTrade = (body.position as PositionView | undefined) ?? null;
        record({ index, status: "PLACED", text: String(body.summary ?? "Placed on the Smart Scalper") });
        return { placed: index };
      }
      const reasons = Array.isArray(body.reasons) ? (body.reasons as unknown[]).slice(0, 4).join(", ") : "";
      const error = String(body.error ?? `HTTP ${result.status}`);
      if (body.blockedByOpenTrade) { record({ index, status: "IN_TRADE", text: error }); return { placed: null }; }
      if (result.status === 0) record({ index, status: "ERROR", text: error });
      else if (error.startsWith("V5 no-trade gate")) record({ index, status: "WAITING", text: `${name}: waiting for a confirmed setup${body.strategyReason && config.strategy === "NIFTY_SNIPER" ? ` (${String(body.strategyReason).slice(0, 160)})` : reasons ? `: ${reasons}` : ""}` });
      else record({ index, status: "BLOCKED", text: `${error}${reasons ? ` (${reasons})` : ""}` });
    }
    return { placed: null };
  } finally {
    state.busy = false;
  }
}

function schedule() {
  if (state.timer) clearTimeout(state.timer);
  const now = deps().now();
  const next = Math.ceil((now - AFTER_CLOSE_MS) / 60_000) * 60_000 + AFTER_CLOSE_MS;
  const at = next > now ? next : next + 60_000;
  state.nextRunAt = new Date(at).toISOString();
  state.timer = setTimeout(() => { void vwapAutoTraderTick().finally(schedule); }, at - now);
  state.timer.unref?.();
}

/** Start once per server process (idempotent): loads the saved switch and runs after every 1m close. */
export function ensureVwapAutoTrader(origin?: string, injected?: AutoTraderDeps) {
  if (origin) state.origin = origin;
  if (!state.origin) state.origin = process.env.SCALPER_MONITOR_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  if (injected) state.deps = injected;
  if (state.timer || (process.env.VITEST && !injected)) return;
  void ensureLoaded();
  schedule();
}

/** Switch auto-execution on or off for one index (the others keep their state), and save it. */
export async function setVwapAutoTrader(input: { index: string; enabled: boolean; riskReward?: string; settings?: Partial<ScalperSettings>; strategy?: AutoStrategy }) {
  await ensureLoaded();
  const index = input.index.toUpperCase();
  // One strategy drives the auto-trader at a time; switching it applies to every watched index.
  const strategy = input.strategy ? strategyOf(input.strategy) : state.config.strategy;
  if (!INDICES.has(index)) throw new Error("Auto-execution trades NIFTY, BANKNIFTY, SENSEX, CRUDEOIL and GOLD options.");
  if (input.enabled && !STRATEGY_INDICES[strategy].has(index)) throw new Error(`${AUTO_STRATEGY_NAMES[strategy]} trades ${[...STRATEGY_INDICES[strategy]].join(", ")} only.`);
  const switched = strategy !== state.config.strategy;
  const current = state.config.indices.filter((item) => STRATEGY_INDICES[strategy].has(item));
  const indices = input.enabled ? [...new Set([...current, index])] : current.filter((item) => item !== index);
  state.config = sanitize({ ...state.config, strategy, indices, enabled: indices.length > 0, riskReward: (input.riskReward ?? state.config.riskReward) as AutoTraderConfig["riskReward"], settings: input.settings ?? state.config.settings, updatedAt: new Date(deps().now()).toISOString() });
  const name = AUTO_STRATEGY_NAMES[strategy];
  record({ index, status: input.enabled ? "WAITING" : "BLOCKED", text: input.enabled ? `Auto-execution on: a confirmed ${name} setup on ${index} is placed on the Smart Scalper${switched ? ` (strategy switched to ${name})` : ""}` : `Auto-execution off for ${index}` });
  await deps().save(state.config).catch(() => undefined);
  return vwapAutoTraderStatus();
}

export function vwapAutoTraderStatus() {
  return {
    ...state.config, running: Boolean(state.timer), lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, lastPlacedAt: state.lastPlacedAt,
    openTrade: state.openTrade ? { label: state.openTrade.label, underlying: state.openTrade.underlying, entry: state.openTrade.entry, stop: state.openTrade.stop, target: state.openTrade.target, stage: state.openTrade.trail?.stage ?? null } : null,
    lastByIndex: state.lastByIndex, events: state.events.slice(0, 15),
  };
}

/** Tests only. */
export function resetVwapAutoTrader() {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, { config: { ...EMPTY }, loaded: false, timer: null, busy: false, deps: null, lastRunAt: null, nextRunAt: null, lastPlacedAt: null, openTrade: null, events: [], lastByIndex: {} });
}
