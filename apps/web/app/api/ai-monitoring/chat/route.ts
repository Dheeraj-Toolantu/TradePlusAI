import { NextResponse } from "next/server";
import { LiteLLMGateway } from "../../../../../../services/ai-monitoring/src/litellm-gateway";

const systemPrompt = `You are TradePulse AI, a disciplined professional Indian derivatives market analyst for NIFTY, BANKNIFTY, and SENSEX.
The Groww analytical brief is the primary authority. Do not merely repeat the browser snapshot or describe what data would be needed tomorrow. Use the calculated Groww brief to make an expert Indian-market judgment now when data is available. The brief includes current price, opening range, EMA, VWAP, RSI, ATR, trend strength, support/resistance, Fibonacci levels, candle pattern, volume, option OI/PCR, IV, Greeks, and liquidity. Validate the brief against the supplied Groww candles and option contracts. Always state the data source, collection time, freshness/availability, and whether the response is based on current Groww data or only historical/context data. You may discuss candlestick patterns, market structure, trend, VWAP, EMA, RSI, MACD, ATR, ADX, volume, OI/PCR, IV, Greeks, Fibonacci retracements/extensions, breakouts, retests, reversals, momentum, mean reversion, and other suitable Indian-market strategies.

Your answer must be concise but useful for a trader. State: market read, evidence, bullish/bearish/neutral bias, key levels, invalidation, option-selection considerations, risk/reward considerations, and what would change your view. Never claim certainty, guaranteed profit, guaranteed accuracy, or risk-free returns. Do not invent prices, indicators, option-chain values, live data, or news that are absent from the context. Clearly say when data is stale, unavailable, or insufficient.

You can prepare an analysis or a paper-trade plan, but you cannot directly place, modify, or cancel orders, change risk limits, activate live mode, bypass the deterministic risk gate, or disable the kill switch. Any execution requires the existing PAPER/ASSISTED controls and server-side safety gates. If Groww data collection fails or is stale, say so clearly and do not present a specific trade as current.`;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Body = { message?: unknown; history?: unknown; context?: unknown };

function safeText(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function safeJson(value: unknown, max: number): string {
  try { return JSON.stringify(value).slice(0, max); } catch { return "{}"; }
}

async function requestModelCompletion(input: { endpoint: string; apiKey?: string; model: string; messages: Array<{ role: string; content: string }>; timeoutMs: number }) {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}) },
    body: JSON.stringify({ model: input.model, messages: input.messages, temperature: 0.2, max_tokens: 900 }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function compactCandles(candles: unknown[], limit: number) {
  return candles.slice(-limit).flatMap((candle) => {
    if (!candle || typeof candle !== "object") return [];
    const item = candle as Record<string, unknown>;
    const values = ["time", "timestamp", "open", "high", "low", "close", "volume"];
    const compact = Object.fromEntries(values.filter((key) => item[key] !== undefined).map((key) => [key, typeof item[key] === "number" ? Math.round(Number(item[key]) * 100) / 100 : item[key]]));
    return Object.keys(compact).length >= 5 ? [compact] : [];
  });
}

function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function ema(values: number[], period: number) {
  if (!values.length) return null;
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce((previous, value) => (value - previous) * multiplier + previous, values[0]);
}
function calculateGrowwBrief(candles: unknown[], contracts: unknown[], quote: unknown) {
  const rows = candles.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const open = Number(row.open); const high = Number(row.high); const low = Number(row.low); const close = Number(row.close); const volume = Number(row.volume ?? 0);
    return [open, high, low, close].every(Number.isFinite) ? [{ open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }] : [];
  });
  const closes = rows.map((row) => row.close);
  const recent = rows.slice(-14);
  const ranges = recent.map((row) => row.high - row.low).filter((value) => Number.isFinite(value) && value >= 0);
  const atr14 = average(ranges);
  const volumeAverage = average(rows.slice(-20).map((row) => row.volume).filter((value) => value > 0));
  const latest = rows.at(-1);
  const latestPrice = latest?.close ?? Number((quote as Record<string, unknown> | undefined)?.price);
  const highs = rows.slice(-30).map((row) => row.high);
  const lows = rows.slice(-30).map((row) => row.low);
  const high = highs.length ? Math.max(...highs) : null;
  const low = lows.length ? Math.min(...lows) : null;
  const vwapVolume = rows.slice(-30).reduce((sum, row) => sum + row.volume, 0);
  const vwap = vwapVolume > 0 ? rows.slice(-30).reduce((sum, row) => sum + row.close * row.volume, 0) / vwapVolume : average(closes.slice(-30));
  const ema9 = ema(closes.slice(-60), 9);
  const ema20 = ema(closes.slice(-60), 20);
  const change = closes.length > 1 ? closes.at(-1)! - closes.at(-2)! : null;
  const trend = ema9 !== null && ema20 !== null && latestPrice !== undefined ? ema9 > ema20 && latestPrice >= vwap! ? "BULLISH" : ema9 < ema20 && latestPrice <= vwap! ? "BEARISH" : "RANGE_OR_CHOP" : "INSUFFICIENT_DATA";
  const fib = high !== null && low !== null ? { level382: high - (high - low) * 0.382, level500: high - (high - low) * 0.5, level618: high - (high - low) * 0.618 } : null;
  const optionRows = contracts.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
  const callOi = optionRows.filter((row) => String(row.contract).toUpperCase() === "CALL").reduce((sum, row) => sum + Number(row.openInterest ?? 0), 0);
  const putOi = optionRows.filter((row) => String(row.contract).toUpperCase() === "PUT").reduce((sum, row) => sum + Number(row.openInterest ?? 0), 0);
  return { latestPrice, candleCount: rows.length, trend, change, ema9, ema20, vwap, atr14, support: low, resistance: high, fibonacci: fib, openingRange: { high: rows.slice(0, 6).length ? Math.max(...rows.slice(0, 6).map((row) => row.high)) : null, low: rows.slice(0, 6).length ? Math.min(...rows.slice(0, 6).map((row) => row.low)) : null }, volumeAverage, latestVolume: latest?.volume ?? null, relativeVolume: volumeAverage && latest ? latest.volume / volumeAverage : null, candle: latest ? { open: latest.open, high: latest.high, low: latest.low, close: latest.close, bullish: latest.close >= latest.open } : null, optionSummary: { callOi, putOi, pcr: callOi > 0 ? putOi / callOi : null, contracts: optionRows.length, topContracts: optionRows.slice(0, 4) } };
}

async function fetchJson(origin: string, path: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await fetch(`${origin}${path}`, { cache: "no-store", signal: AbortSignal.timeout(40_000) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: response.ok, body };
  } catch (error) {
    return { ok: false, body: { error: error instanceof Error ? error.message : "Market data request failed" } };
  }
}

async function collectGrowwContext(origin: string, symbol: string) {
  const selected = ["NIFTY", "BANKNIFTY", "SENSEX"].includes(symbol) ? symbol : "NIFTY";
  const date = new Date().toISOString().slice(0, 10);
  const [quote, dayHistory, weekHistory, optionChain] = await Promise.all([
    fetchJson(origin, `/api/market-data?provider=groww&symbols=${encodeURIComponent(selected)}`),
    fetchJson(origin, `/api/market-data/history?provider=groww&symbol=${encodeURIComponent(selected)}&timeframe=5m&period=day&date=${date}`),
    fetchJson(origin, `/api/market-data/history?provider=groww&symbol=${encodeURIComponent(selected)}&timeframe=5m&period=week&date=${date}`),
    fetchJson(origin, `/api/option-chain?symbol=${encodeURIComponent(selected)}`),
  ]);
  const rawDayCandles = Array.isArray(dayHistory.body.candles) ? dayHistory.body.candles : [];
  const rawWeekCandles = Array.isArray(weekHistory.body.candles) ? weekHistory.body.candles : [];
  const dayCandles = compactCandles(rawDayCandles, 30);
  const weekCandles = compactCandles(rawWeekCandles, 50);
  const contracts = Array.isArray(optionChain.body.contracts) ? optionChain.body.contracts.slice(0, 8) : [];
  const sources = {
    quote: quote.body.source ?? "Groww quote unavailable",
    dayHistory: dayHistory.body.source ?? "Groww day history unavailable",
    weekHistory: weekHistory.body.source ?? "Groww week history unavailable",
    optionChain: optionChain.body.source ?? "Groww option chain unavailable",
  };
  return {
    provider: "groww",
    collectedAt: new Date().toISOString(),
    dataQuality: { quote: quote.ok ? "AVAILABLE" : "UNAVAILABLE", dayHistory: dayHistory.ok && rawDayCandles.length ? "AVAILABLE" : "UNAVAILABLE", weekHistory: weekHistory.ok && rawWeekCandles.length ? "AVAILABLE" : "UNAVAILABLE", optionChain: optionChain.ok && contracts.length ? "AVAILABLE" : "UNAVAILABLE" },
    counts: { rawDayCandles: rawDayCandles.length, rawWeekCandles: rawWeekCandles.length, candlesSentToModel: dayCandles.length + weekCandles.length, contractsSentToModel: contracts.length },
    sources,
    quote: quote.body.quotes ?? [],
    historical: { timeframe: "5m", day: dayCandles, week: weekCandles },
    optionChain: { expiry: optionChain.body.expiry ?? null, spot: optionChain.body.spot ?? null, contracts },
  };
}

export async function POST(request: Request) {
  if (!request.headers.get("x-user-id")) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Body;
  const message = safeText(body.message, 2000).trim();
  if (!message) return NextResponse.json({ error: "A message is required." }, { status: 400 });
  const history = Array.isArray(body.history) ? body.history.filter((item): item is ChatMessage => Boolean(item && typeof item === "object" && ["user", "assistant"].includes(String((item as ChatMessage).role)) && typeof (item as ChatMessage).content === "string")).slice(-10).map((item) => ({ role: item.role, content: item.content.slice(0, 2000) })) : [];
  const clientContext = body.context && typeof body.context === "object" ? body.context as Record<string, unknown> : {};
  const symbol = String(clientContext.symbol ?? "NIFTY").toUpperCase();
  const liveMarketContext = await collectGrowwContext(new URL(request.url).origin, symbol);
  const pageSnapshot = { symbol: clientContext.symbol, timeframe: clientContext.timeframe, executionMode: clientContext.executionMode, monitoringState: clientContext.monitoringState, marketStatus: clientContext.marketStatus, deterministicAnalysis: clientContext.deterministicAnalysis, risk: clientContext.risk };
  const growwBrief = calculateGrowwBrief(liveMarketContext.historical.day, liveMarketContext.optionChain.contracts, liveMarketContext.quote[0]);
  const context = safeJson({ pageSnapshot, growwBrief, growwMarketData: liveMarketContext }, 10_000);
  const chatTimeoutMs = Number(process.env.AI_CHAT_TIMEOUT_MS ?? 60_000);
  const modelAlias = process.env.LITELLM_MODEL ?? "openai/gpt-oss-20b";
  const gateway = new LiteLLMGateway({ endpoint: process.env.LITELLM_ENDPOINT ?? "", apiKey: process.env.LITELLM_API_KEY, modelAlias, timeoutMs: chatTimeoutMs });
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: `Current page context:\n${context}\n\nTrader request:\n${message}` }];
  try {
    let raw: Record<string, unknown>;
    try {
      if (!gateway.status().state || !process.env.LITELLM_ENDPOINT) throw new Error("Local LiteLLM endpoint is not configured");
      raw = await requestModelCompletion({ endpoint: process.env.LITELLM_ENDPOINT, apiKey: process.env.LITELLM_API_KEY, model: gateway.status().modelAlias, messages, timeoutMs: chatTimeoutMs });
    } catch (localError) {
      if (!process.env.GROQ_API_KEY) throw localError;
      raw = await requestModelCompletion({ endpoint: "https://api.groq.com/openai/v1/chat/completions", apiKey: process.env.GROQ_API_KEY, model: "openai/gpt-oss-20b", messages, timeoutMs: chatTimeoutMs });
    }
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const modelMessage = choice?.message as Record<string, unknown> | undefined;
    const content = safeText(modelMessage?.content, 6000);
    if (!content) throw new Error("Model returned an empty response");
    return NextResponse.json({ content, model: raw.model ?? gateway.status().modelAlias, createdAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI chat unavailable";
    const timeout = message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted");
    const providerLimit = message.includes("429") || message.includes("413") || message.toLowerCase().includes("tokens per minute");
    return NextResponse.json({ error: providerLimit ? "AI provider rate/context limit reached. Groww data was collected, but the model request was rejected; deterministic analysis remains authoritative." : timeout ? "AI chat timed out while collecting Groww data or waiting for the model. Deterministic analysis remains authoritative." : message }, { status: 503 });
  }
}
