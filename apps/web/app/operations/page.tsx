"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventChips, IndexCorporatePanel, StockEvents } from "../../components/corporate-events";
import { RetailCrowdDesk } from "../../components/retail-crowd-desk";
import { TelegramLiveFeed } from "../../components/telegram-live-feed";
import { TelegramOptionsDesk } from "../../components/telegram-options";
import { useLiveFeeds } from "../../components/use-live-feeds";
import { mergeTelegram } from "../../lib/telegram-merge";
import type { TelegramLive } from "../../lib/telegram-live";
import type { ConstituentSentiment, IndexId, IndexSentiment, IndexSentimentReading, Lens } from "../../lib/index-sentiment";

const LENSES: Array<{ key: Lens; title: string; weight: string }> = [
  { key: "price", title: "Price action", weight: "25%" },
  { key: "volume", title: "Volume (accumulation / distribution)", weight: "10%" },
  { key: "orderflow", title: "Buyers vs sellers (order book, delivery)", weight: "14%" },
  { key: "news", title: "News (Moneycontrol, ET, Mint, blogs, global)", weight: "25%" },
  { key: "social", title: "Retail traders (forums)", weight: "14%" },
  { key: "events", title: "Corporate events (deals, results, filings)", weight: "12%" },
];
type SortKey = "weight" | "score" | "change" | "contribution";
type Filter = "ALL" | "TIPPED" | "BULLISH" | "BEARISH" | "NEUTRAL";

const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`);
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();
const age = (hours: number | null | undefined) => (hours === null || hours === undefined ? "--" : hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago` : `${hours.toFixed(1)}h ago`);
const qty = (value: number | null | undefined) => (value === null || value === undefined ? "--" : value >= 1e7 ? `${(value / 1e7).toFixed(2)} Cr` : value >= 1e5 ? `${(value / 1e5).toFixed(1)} L` : value.toLocaleString("en-IN"));
const TIER_LABEL: Record<string, string> = { PREMIUM: "Top outlet", STANDARD: "News", BLOG: "Blog", TELEGRAM: "Telegram" };

/** Two-sided split: buyers (green, left) vs sellers (red, right). */
function SplitBar({ left, label }: { left: number | null | undefined; label: string }) {
  if (left === null || left === undefined) return <div className="isa-split isa-split-empty" aria-label={`${label}: no data`} />;
  return (
    <div className="isa-split" role="img" aria-label={`${label}: ${left.toFixed(0)}% vs ${(100 - left).toFixed(0)}%`}>
      <i className="isa-fill-up" style={{ width: `${left}%` }} /><i className="isa-fill-down" style={{ width: `${100 - left}%` }} />
    </div>
  );
}

function ScoreBar({ score, compact = false }: { score: number | null | undefined; compact?: boolean }) {
  const value = score === null || score === undefined ? null : Math.max(-100, Math.min(100, score));
  const width = value === null ? 0 : Math.abs(value) / 2;
  return (
    <div className={`isa-bar${compact ? " isa-bar-compact" : ""}`} role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-label="Sentiment score">
      <span className="isa-bar-mid" />
      {value !== null ? <i className={value >= 0 ? "isa-fill-up" : "isa-fill-down"} style={{ width: `${width}%`, left: value >= 0 ? "50%" : `${50 - width}%` }} /> : null}
    </div>
  );
}

function Breadth({ reading }: { reading: IndexSentimentReading }) {
  const { bullish_pct, neutral_pct, bearish_pct, advances, declines } = reading.breadth;
  return (
    <div className="isa-breadth">
      <div className="isa-breadth-bar" title="Share of index weight with bullish / neutral / bearish sentiment">
        <i className="isa-fill-up" style={{ width: `${bullish_pct}%` }} />
        <i className="isa-neutral" style={{ width: `${neutral_pct}%` }} />
        <i className="isa-fill-down" style={{ width: `${bearish_pct}%` }} />
      </div>
      <small>{bullish_pct.toFixed(0)}% bull · {bearish_pct.toFixed(0)}% bear by weight · A/D {advances}:{declines}</small>
    </div>
  );
}

const IndexCard = memo(function IndexCard({ reading, active, onSelect }: { reading: IndexSentimentReading; active: boolean; onSelect: (id: IndexId) => void }) {
  return (
    <button type="button" className={`isa-card${active ? " active" : ""}`} onClick={() => onSelect(reading.id)} aria-pressed={active}>
      <div className="isa-card-head">
        <b>{reading.name}</b>
        {reading.quote ? <span className={tone((reading.quote.change_pct ?? 0) * 40)}>{reading.quote.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ({signed(reading.quote.change_pct, 2)}%)</span> : null}
      </div>
      <div className="isa-card-score">
        <strong className={tone(reading.score)}>{signed(reading.score)}</strong>
        <div><em className={tone(reading.score)}>{reading.zone}</em>{words(reading.label) !== reading.zone.toLowerCase() ? <small>{words(reading.label)}</small> : null}</div>
      </div>
      <ScoreBar score={reading.score} />
      <Breadth reading={reading} />
      <small className="isa-card-foot">{reading.coverage.stocks_scored}/{reading.coverage.stocks_total} stocks scored · {active ? "showing constituents" : "click for constituents"}</small>
    </button>
  );
});

function ConstituentDetail({ stock }: { stock: ConstituentSentiment }) {
  return (
    <div className="isa-detail">
      <div className="isa-detail-lenses">
        {LENSES.map((lens) => (
          <div key={lens.key}>
            <small>{lens.title} <i>({lens.weight})</i></small>
            <div className="isa-lens-row"><ScoreBar score={stock.components[lens.key]} compact /><b className={tone(stock.components[lens.key])}>{signed(stock.components[lens.key])}</b></div>
          </div>
        ))}
        <p className="isa-facts">
          5-day {signed(stock.five_day_pct, 1)}% · vs 20-DMA {signed(stock.vs_20dma_pct, 1)}% · volume {stock.volume_ratio === null ? "--" : `${stock.volume_ratio.toFixed(1)}x avg`} · confidence {stock.confidence.toLowerCase()}
          {stock.social_raw !== null && stock.social_raw !== stock.components.social ? ` · raw forum mood ${signed(stock.social_raw)} (damped: crowded trade)` : ""}
        </p>
        <div className="isa-mini">
          <small>Buyers vs sellers (pending quantity)</small>
          <SplitBar left={stock.orderflow.buy_pct} label="Buyers vs sellers" />
          <p className="isa-facts">{stock.orderflow.buy_pct === null
            ? "Order book unavailable (market closed or NSE unreachable)."
            : `Buy ${qty(stock.orderflow.buy_qty)} (${stock.orderflow.buy_pct.toFixed(0)}%) vs sell ${qty(stock.orderflow.sell_qty)} (${(100 - stock.orderflow.buy_pct).toFixed(0)}%)${stock.orderflow.bid_orders !== null ? ` · ${stock.orderflow.bid_orders} buy / ${stock.orderflow.ask_orders ?? "--"} sell orders at best 5` : ""}`}
            {stock.orderflow.delivery_pct !== null ? ` · delivery ${stock.orderflow.delivery_pct.toFixed(0)}%` : ""}</p>
          <small>Retail traders</small>
          <p className="isa-facts">{stock.retail.posts ? `${stock.retail.posts} posts · ${stock.retail.bullish} bullish / ${stock.retail.bearish} bearish` : "No retail chatter in the window."}</p>
          {stock.retail.telegram.posts ? <p className="isa-facts">Telegram: {stock.retail.telegram.posts} posts in {stock.retail.telegram.channels} channel(s) · <span className="isa-up">{stock.retail.telegram.buy_calls} buy</span> / <span className="isa-down">{stock.retail.telegram.sell_calls} sell</span> calls{stock.retail.telegram.hype_posts ? ` · ${stock.retail.telegram.hype_posts} hype posts` : ""}</p> : null}
          <small>News freshness</small>
          <p className="isa-facts">{stock.news_count ? `${stock.news_count} items (${stock.news_fresh_count} in the last 4h, ${stock.premium_news_count} from top outlets) · latest ${age(stock.latest_news_age_hours)}` : "No news in the freshness window."}</p>
        </div>
      </div>
      <div>
        {stock.notes.length ? <ul className="isa-notes">{stock.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        <small className="ce-label">Corporate events &amp; deals</small>
        <StockEvents stock={stock} />
        <small className="ce-label">Latest news &amp; retail chatter</small>
        {stock.headlines.some((headline) => !headline.event) ? (
          <ul className="isa-headlines">
            {stock.headlines.filter((headline) => !headline.event).map((headline) => (
              <li key={headline.link + headline.title}>
                <b className={tone(headline.score)}>{signed(headline.score)}</b>
                <a href={headline.link} target="_blank" rel="noreferrer">{headline.title}</a>
                <small><span className={`isa-tier isa-tier-${headline.tier.toLowerCase()}`}>{TIER_LABEL[headline.tier] ?? headline.tier}</span> {headline.source} · {age(headline.age_hours)}</small>
              </li>
            ))}
          </ul>
        ) : <p className="isa-muted">No news or forum chatter in the freshness window: reading is market data only.</p>}
      </div>
    </div>
  );
}

const ConstituentTable = memo(function ConstituentTable({ reading }: { reading: IndexSentimentReading }) {
  const [sort, setSort] = useState<SortKey>("weight");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = reading.constituents.filter((stock) => {
      if (needle && !`${stock.symbol} ${stock.name} ${stock.sector}`.toLowerCase().includes(needle)) return false;
      if (filter === "TIPPED") return stock.retail.telegram.buy_calls + stock.retail.telegram.sell_calls > 0;
      if (filter === "BULLISH") return (stock.score ?? 0) >= 12;
      if (filter === "BEARISH") return (stock.score ?? 0) <= -12;
      if (filter === "NEUTRAL") return stock.score !== null && Math.abs(stock.score) < 12;
      return true;
    });
    const key = (stock: ConstituentSentiment) => (sort === "weight" ? stock.weight : sort === "score" ? stock.score ?? -999 : sort === "change" ? stock.change_pct ?? -999 : Math.abs(stock.contribution ?? 0));
    return [...matches].sort((a, b) => key(b) - key(a));
  }, [reading, sort, filter, query]);

  return (
    <section className="isa-panel">
      <div className="isa-table-tools">
        <h3>{reading.name} constituents <small>({reading.constituents.length})</small></h3>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search stock or sector" aria-label="Search constituents" />
        <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} aria-label="Filter by sentiment">
          <option value="ALL">All</option><option value="TIPPED">Tipped on Telegram</option><option value="BULLISH">Bullish</option><option value="NEUTRAL">Neutral</option><option value="BEARISH">Bearish</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort constituents">
          <option value="weight">Sort: index weight</option><option value="score">Sort: sentiment score</option><option value="change">Sort: day change</option><option value="contribution">Sort: impact on index</option>
        </select>
      </div>
      <div className="isa-table-wrap">
        <table className="isa-table">
          <thead><tr><th>Stock</th><th>Weight</th><th>Price</th><th>Day</th><th>Vol</th><th className="isa-col-split">Buyers / sellers</th><th className="isa-col-bar">Sentiment</th><th>Score</th><th>Impact</th></tr></thead>
          <tbody>
            {rows.map((stock) => (
              <Fragment key={stock.symbol}>
                <tr className={open === stock.symbol ? "open" : ""} onClick={() => setOpen(open === stock.symbol ? null : stock.symbol)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === stock.symbol ? null : stock.symbol); } }} aria-expanded={open === stock.symbol}>
                  <td><b>{stock.symbol}</b><EventChips stock={stock} /><small>{stock.name} · {stock.sector}</small></td>
                  <td>{stock.weight.toFixed(1)}%</td>
                  <td>{stock.price === null ? "--" : stock.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                  <td className={tone((stock.change_pct ?? 0) * 20)}>{signed(stock.change_pct, 2)}%</td>
                  <td className={stock.volume_ratio !== null && stock.volume_ratio >= 1.5 ? "isa-hot" : ""}>{stock.volume_ratio === null ? "--" : `${stock.volume_ratio.toFixed(1)}x`}</td>
                  <td className="isa-col-split"><SplitBar left={stock.orderflow.buy_pct} label="Buyers vs sellers" /><small>{stock.orderflow.buy_pct === null ? "no book" : `${stock.orderflow.buy_pct.toFixed(0)}% buy`}{stock.retail.posts ? ` · ${stock.retail.posts} posts` : ""}</small></td>
                  <td className="isa-col-bar"><ScoreBar score={stock.score} /><small className={tone(stock.score)}>{words(stock.label)}</small></td>
                  <td><b className={tone(stock.score)}>{signed(stock.score)}</b></td>
                  <td className={tone((stock.contribution ?? 0) * 10)}>{signed(stock.contribution, 1)}</td>
                </tr>
                {open === stock.symbol ? <tr className="isa-detail-row"><td colSpan={9}><ConstituentDetail stock={stock} /></td></tr> : null}
              </Fragment>
            ))}
            {rows.length === 0 ? <tr><td colSpan={9} className="isa-muted">No constituents match.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <small className="isa-muted">Impact = index weight × score: the points this stock adds to or takes from the index reading. Buyers / sellers = pending buy vs sell quantity in the NSE order book. Click a row for the full breakdown and the latest headlines.</small>
    </section>
  );
});

const IndexDetail = memo(function IndexDetail({ reading }: { reading: IndexSentimentReading }) {
  const lens = reading.lenses;
  return (
    <>
      <section className="isa-grid">
        <div className="isa-panel">
          <h3>Market psychology read</h3>
          <p className="isa-fresh">News window: last {reading.freshness.max_age_hours.toFixed(0)}h · {reading.freshness.news_items} items on {reading.freshness.stocks_with_news} stocks ({reading.freshness.fresh_items} in the last {reading.freshness.fresh_window_hours.toFixed(0)}h, {reading.freshness.premium_items} from top outlets) · latest {age(reading.freshness.latest_news_age_hours)}</p>
          <p className="isa-bias"><b>Bias:</b> {reading.bias}</p>
          <ul className="isa-notes">{reading.psychology.map((note) => <li key={note}>{note}</li>)}</ul>
        </div>
        <div className="isa-panel">
          <h3>What is driving the score</h3>
          {[...LENSES.map((item) => ({ title: `${item.title} (${item.weight})`, value: lens[item.key] })),
            { title: "Top 5 heavyweights", value: lens.heavyweights },
            { title: "Rest of the index", value: lens.rest },
            { title: "Constituents (weighted)", value: reading.constituent_score },
            { title: "Macro backdrop: VIX, FII/DII, global (20%)", value: reading.macro_score },
          ].map((item) => (
            <div className="isa-lens-row" key={item.title}><small>{item.title}</small><ScoreBar score={item.value} compact /><b className={tone(item.value)}>{signed(item.value)}</b></div>
          ))}
        </div>
      </section>
      <section className="isa-grid">
        <div className="isa-panel">
          <h3>Buyers vs sellers</h3>
          <SplitBar left={reading.orderflow.buy_pct} label="Index buyers vs sellers" />
          {reading.orderflow.buy_pct === null ? <p className="isa-muted">Order book unavailable: NSE publishes pending quantities during market hours, and may block some networks.</p> : (
            <div className="isa-stats">
              <p><b className="isa-up">{reading.orderflow.buy_pct.toFixed(0)}%</b><small>buy quantity (weighted)</small></p>
              <p><b className="isa-down">{(100 - reading.orderflow.buy_pct).toFixed(0)}%</b><small>sell quantity</small></p>
              <p><b>{reading.orderflow.buyer_dominated} / {reading.orderflow.seller_dominated}</b><small>stocks led by buyers / sellers</small></p>
              <p><b>{reading.orderflow.delivery_pct === null ? "--" : `${reading.orderflow.delivery_pct.toFixed(0)}%`}</b><small>avg delivery</small></p>
            </div>
          )}
          <small className="isa-muted">{reading.orderflow.stocks_covered}/{reading.constituents.length} stocks with a live book · pending buy {qty(reading.orderflow.buy_qty)} vs sell {qty(reading.orderflow.sell_qty)} shares</small>
        </div>
        <div className="isa-panel">
          <h3>Retail traders</h3>
          <SplitBar left={reading.retail.bullish_pct} label="Retail bullish vs bearish posts" />
          <div className="isa-stats">
            <p><b className={tone(reading.retail.mood)}>{signed(reading.retail.mood)}</b><small>forum mood</small></p>
            <p><b>{reading.retail.posts}</b><small>posts ({reading.retail.bullish} bull / {reading.retail.bearish} bear)</small></p>
            <p><b className={tone(reading.retail.mmi_score)}>{reading.retail.mmi_value ?? "--"}</b><small>Market Mood Index</small></p>
            <p><b className={tone(reading.retail.retail_market_score)}>{signed(reading.retail.retail_market_score)}</b><small>retail mood composite</small></p>
          </div>
          <div className="tg-row">
            <small>Telegram channels</small>
            {reading.retail.telegram.posts ? (
              <p className="isa-facts">{reading.retail.telegram.posts} posts · <span className="isa-up">{reading.retail.telegram.buy_calls} buy</span> / <span className="isa-down">{reading.retail.telegram.sell_calls} sell</span> calls{reading.retail.telegram.hype_posts ? ` · ${reading.retail.telegram.hype_posts} hype posts` : ""}
                {reading.retail.telegram.most_tipped.length ? ` · most tipped: ${reading.retail.telegram.most_tipped.map((row) => `${row.symbol} (${row.buy_calls}↑/${row.sell_calls}↓${row.hype_posts ? `, ${row.hype_posts} hype` : ""})`).join(", ")}` : ""}</p>
            ) : <p className="isa-muted">No Telegram calls on these stocks in the window{reading.retail.telegram.posts === 0 ? " (set TELEGRAM_CHANNELS to scan channels)" : ""}.</p>}
          </div>
          {reading.retail.most_discussed.length ? <small className="isa-muted">Most discussed: {reading.retail.most_discussed.map((row) => `${row.symbol} (${row.posts})`).join(", ")}</small> : <small className="isa-muted">No retail chatter on these stocks in the window.</small>}
        </div>
      </section>
      <section className="isa-grid">
        <div className="isa-panel">
          <h3>Sector sentiment</h3>
          {reading.sectors.map((sector) => (
            <div className="isa-lens-row" key={sector.sector}><small>{sector.sector} <i>{sector.weight.toFixed(1)}% · {sector.stocks}</i></small><ScoreBar score={sector.score} compact /><b className={tone(sector.score)}>{signed(sector.score)}</b></div>
          ))}
        </div>
        <div className="isa-panel">
          <h3>Biggest movers of the reading</h3>
          <div className="isa-drivers">
            <div><small>Lifting the index</small>{reading.drivers.positive.map((driver) => <p key={driver.symbol}><b>{driver.symbol}</b><span className="isa-up">{signed(driver.contribution, 1)}</span><i>score {signed(driver.score)} · wt {driver.weight.toFixed(1)}%</i></p>)}{reading.drivers.positive.length === 0 ? <p className="isa-muted">None</p> : null}</div>
            <div><small>Dragging the index</small>{reading.drivers.negative.map((driver) => <p key={driver.symbol}><b>{driver.symbol}</b><span className="isa-down">{signed(driver.contribution, 1)}</span><i>score {signed(driver.score)} · wt {driver.weight.toFixed(1)}%</i></p>)}{reading.drivers.negative.length === 0 ? <p className="isa-muted">None</p> : null}</div>
          </div>
        </div>
      </section>
      <IndexCorporatePanel reading={reading} />
      <ConstituentTable reading={reading} />
    </>
  );
});

export default function OperationsPage() {
  const [scan, setScan] = useState<IndexSentiment | null>(null);
  const [telegram, setTelegram] = useState<TelegramLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<IndexId | null>("NIFTY");
  const scanTime = useRef<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      // "no-cache" revalidates with the ETag: an unchanged scan costs a 304, not a 100+ KB download.
      const response = await fetch(`/api/index-sentiment${force ? "?refresh=1" : ""}`, { cache: force ? "no-store" : "no-cache" });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error ?? "Index sentiment unavailable");
      if (body.generated_at !== scanTime.current) { scanTime.current = body.generated_at; setScan(body as IndexSentiment); }
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Index sentiment unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Pushes over WebSocket (or HTTP polling as a fallback): Telegram every ~minute, and a notice
  // when a new full scan exists, which is then fetched once. Nothing runs while the tab is hidden.
  const { connection, telegramError } = useLiveFeeds({
    onTelegram: setTelegram,
    onNewScan: (generatedAt) => { if (generatedAt !== scanTime.current) void load(); },
  });
  const refresh = useCallback(() => {
    void load(true);
    void fetch("/api/telegram-live?refresh=1", { cache: "no-store" }).then((response) => response.json()).then((body) => { if (!body.error) setTelegram(body as TelegramLive); }).catch(() => undefined);
  }, [load]);
  const toggle = useCallback((id: IndexId) => setSelected((current) => (current === id ? null : id)), []);
  const data = useMemo(() => mergeTelegram(scan, telegram), [scan, telegram]);

  const reading = data?.indices.find((index) => index.id === selected) ?? null;
  return (
    <main className="isa-page">
      <header className="isa-header">
        <div>
          <p className="isa-kicker">MARKET PSYCHOLOGY DESK</p>
          <h1>Index Sentiment Analyser</h1>
          <p className="isa-muted">NIFTY 50, BANK NIFTY and SENSEX read bottom-up from every constituent: free-float weight, price action, volume, NSE buyers vs sellers, the last few hours of Moneycontrol, Economic Times, Mint and market-blog news, and retail traders.</p>
        </div>
        <div className="isa-actions">
          <button type="button" onClick={refresh} disabled={loading}>{loading ? "Scanning…" : "Refresh"}</button>
          {data ? <small>Updated {new Date(data.generated_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST</small> : null}
          <a href="/">Back to dashboard</a>
        </div>
      </header>

      {error ? <p className="isa-alert">{error}{data ? " (showing the last good scan)" : ""}</p> : null}
      {!data && !error ? <p className="isa-panel isa-muted">Scanning 60+ stocks, per-company news and forums… the first scan can take up to a minute.</p> : null}

      {data ? (
        <>
          <section className="isa-cards">
            {data.indices.map((index) => <IndexCard key={index.id} reading={index} active={index.id === selected} onSelect={toggle} />)}
          </section>
          {data.retail_desk ? <RetailCrowdDesk desk={data.retail_desk} /> : null}
          {data.telegram_options ? <TelegramOptionsDesk options={data.telegram_options} /> : null}
          <TelegramLiveFeed live={telegram} connection={connection} error={telegramError} />
          {reading ? <IndexDetail reading={reading} /> : <p className="isa-muted">Select an index to see its constituents.</p>}
          <section className="isa-panel isa-sources">
            <h3>Data sources</h3>
            <div>{data.feeds.map((feed) => <span key={feed.id} className={feed.ok ? "isa-chip ok" : "isa-chip"}>{feed.name}: {feed.fresh} fresh / {feed.items}</span>)}</div>
            <div>{data.sources.map((source) => <span key={source.id} className={source.ok ? "isa-chip ok" : "isa-chip"} title={source.errors.join("\n")}>{source.name}: {source.ok}/{source.ok + source.failed}{source.cached ? ` (${source.cached} cached)` : ""}</span>)}</div>
            <p className="isa-muted">{data.method}</p>
          </section>
        </>
      ) : null}

      <section className="isa-panel isa-ops">
        <h3>Journal &amp; audit</h3>
        <p className="isa-muted">All decision and execution records are append-only and mode-labelled. Paper performance is kept separate from assisted and live results. Sentiment is context for risk, never an order trigger.</p>
      </section>
    </main>
  );
}
