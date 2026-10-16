import type { IndexId, IndexSentiment } from "./index-sentiment";
import type { TelegramLive } from "./telegram-live";

export type AlertKind = "telegram" | "option" | "news" | "sentiment";
export type AlertTone = "up" | "down" | "flat";
export type SentimentAlert = { id: string; kind: AlertKind; tone: AlertTone; title: string; body: string; link?: string; at: string };

export type AlertPrefs = {
  telegram: boolean;
  /** Only Telegram posts that carry a NIFTY / BANKNIFTY / SENSEX option call. */
  telegramIndexOnly: boolean;
  options: boolean;
  news: boolean;
  /** Headlines scoring at least this (absolute, -100..100) raise an alert. */
  newsMinScore: number;
  premiumOnly: boolean;
  sentiment: boolean;
  /** Points an index score must move (since its last alert) to raise a new alert. */
  scoreStep: number;
  sound: boolean;
  desktop: boolean;
};

export const DEFAULT_PREFS: AlertPrefs = {
  telegram: true, telegramIndexOnly: false, options: true,
  news: true, newsMinScore: 15, premiumOnly: false,
  sentiment: true, scoreStep: 8,
  sound: true, desktop: true,
};

/** What the page has already seen; the first scan of each feed seeds it without alerting. */
export type AlertBaseline = {
  posts: Set<string> | null;
  topPick: string | null | undefined;
  headlines: Set<string> | null;
  indices: Partial<Record<IndexId, { score: number | null; zone: string }>>;
};

export const emptyBaseline = (): AlertBaseline => ({ posts: null, topPick: undefined, headlines: null, indices: {} });

const INDEX_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
const NEWS_MAX_AGE_HOURS = 2;
const GROUP_OVER = 3;
const clip = (text: string, length = 160) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);
const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(0)}`;
const toneOf = (score: number | null | undefined, band = 12): AlertTone => (score === null || score === undefined ? "flat" : score >= band ? "up" : score <= -band ? "down" : "flat");
let counter = 0;
const make = (alert: Omit<SentimentAlert, "id" | "at">, at: string): SentimentAlert => ({ ...alert, at, id: `${alert.kind}-${Date.now().toString(36)}-${(counter++).toString(36)}` });

/** Collapse a burst into one alert so a backlog doesn't fire a dozen sounds. */
function grouped(alerts: SentimentAlert[], kind: AlertKind, label: string, at: string): SentimentAlert[] {
  if (alerts.length <= GROUP_OVER) return alerts;
  const up = alerts.filter((alert) => alert.tone === "up").length;
  const down = alerts.filter((alert) => alert.tone === "down").length;
  return [make({
    kind, tone: up > down ? "up" : down > up ? "down" : "flat",
    title: `${alerts.length} new ${label}`,
    body: alerts.slice(0, 3).map((alert) => alert.title).join(" · "),
    link: alerts[0].link,
  }, at)];
}

export function diffTelegram(base: AlertBaseline, live: TelegramLive, prefs: AlertPrefs): SentimentAlert[] {
  const at = new Date().toISOString();
  const out: SentimentAlert[] = [];
  const links = live.feed.map((post) => post.link);
  if (base.posts === null) {
    base.posts = new Set(links);
  } else {
    const arrived = live.feed.filter((post) => !base.posts!.has(post.link));
    arrived.forEach((post) => base.posts!.add(post.link));
    if (prefs.telegram) {
      const relevant = arrived.filter((post) => !prefs.telegramIndexOnly || post.options.some((call) => INDEX_UNDERLYINGS.some((name) => call.toUpperCase().startsWith(name))));
      const posts = relevant.map((post) => {
        const ce = post.options.filter((call) => call.endsWith("CE")).length;
        const pe = post.options.filter((call) => call.endsWith("PE")).length;
        const tags = [...post.options, ...post.stocks].slice(0, 4).join(", ");
        return make({ kind: "telegram", tone: ce > pe ? "up" : pe > ce ? "down" : "flat", title: `@${post.channel}${tags ? `: ${tags}` : ""}`, body: clip(post.text), link: post.link }, at);
      });
      out.push(...grouped(posts, "telegram", "Telegram posts", at));
    }
  }

  const pick = live.options.top_pick;
  const pickKey = pick ? `${pick.side} ${pick.contract}` : null;
  if (base.topPick !== undefined && pickKey !== base.topPick && pick && prefs.options) {
    const levels = [pick.entry !== null ? `entry ${pick.entry}` : "", pick.target !== null ? `target ${pick.target}` : "", pick.stop !== null ? `stop ${pick.stop}` : ""].filter(Boolean).join(" · ");
    out.push(make({
      kind: "option", tone: (pick.type === "CE") === (pick.side === "BUY") ? "up" : "down",
      title: `New Telegram consensus: ${pickKey}`,
      body: `${pick.mentions} mentions in ${pick.channel_count} channel(s)${levels ? ` · ${levels}` : ""}`,
      link: pick.posts[0]?.link,
    }, at));
  }
  base.topPick = pickKey;
  return out;
}

export function diffScan(base: AlertBaseline, scan: IndexSentiment, prefs: AlertPrefs): SentimentAlert[] {
  const at = new Date().toISOString();
  const out: SentimentAlert[] = [];

  for (const index of scan.indices) {
    const previous = base.indices[index.id];
    if (!previous) { base.indices[index.id] = { score: index.score, zone: index.zone }; continue; }
    if (index.score === null) continue;
    const zoneChanged = previous.zone !== index.zone;
    const moved = previous.score === null ? 0 : index.score - previous.score;
    if (zoneChanged || Math.abs(moved) >= prefs.scoreStep) {
      if (prefs.sentiment) {
        const price = index.quote ? ` · ${index.quote.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}${index.quote.change_pct !== null ? ` (${index.quote.change_pct > 0 ? "+" : ""}${index.quote.change_pct.toFixed(2)}%)` : ""}` : "";
        out.push(make({
          kind: "sentiment", tone: moved > 0 ? "up" : moved < 0 ? "down" : toneOf(index.score),
          title: zoneChanged ? `${index.name} turned ${index.zone} (${signed(index.score)})` : `${index.name} sentiment ${moved > 0 ? "up" : "down"} ${Math.abs(moved).toFixed(0)} pts to ${signed(index.score)}`,
          body: clip(`${previous.zone} ${previous.score === null ? "--" : signed(previous.score)} → ${index.zone} ${signed(index.score)}${price}. ${index.bias}`),
        }, at));
      }
      // Re-anchor only on an alert, so a slow drift still adds up to one.
      base.indices[index.id] = { score: index.score, zone: index.zone };
    }
  }

  const seen = new Set<string>();
  const fresh: Array<{ alert: SentimentAlert; strength: number }> = [];
  const firstScan = base.headlines === null;
  base.headlines ??= new Set();
  for (const index of scan.indices) {
    for (const stock of index.constituents) {
      for (const headline of stock.headlines) {
        if (headline.tier === "TELEGRAM") continue; // Telegram has its own alerts
        const key = headline.link || headline.title;
        if (seen.has(key)) continue;
        seen.add(key);
        if (base.headlines.has(key)) continue;
        base.headlines.add(key);
        if (firstScan || !prefs.news) continue;
        if (headline.age_hours > NEWS_MAX_AGE_HOURS || Math.abs(headline.score) < prefs.newsMinScore) continue;
        if (prefs.premiumOnly && headline.tier !== "PREMIUM") continue;
        fresh.push({ strength: Math.abs(headline.score), alert: make({
          kind: "news", tone: toneOf(headline.score, 1),
          title: `${stock.symbol} ${signed(headline.score)}: ${clip(headline.title, 110)}`,
          body: `${headline.source}${headline.event ? ` · ${headline.event.replaceAll("_", " ").toLowerCase()}` : ""} · ${stock.name} (${stock.weight.toFixed(1)}% of ${index.name})`,
          link: headline.link,
        }, at) });
      }
    }
  }
  fresh.sort((a, b) => b.strength - a.strength);
  out.push(...grouped(fresh.map((row) => row.alert), "news", "market-moving headlines", at));
  return out;
}
