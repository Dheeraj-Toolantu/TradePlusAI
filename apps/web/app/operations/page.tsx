"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ConstituentSentiment, IndexId, IndexSentiment, IndexSentimentReading, Lens } from "../../lib/index-sentiment";

const REFRESH_MS = 15 * 60_000;
const LENSES: Array<{ key: Lens; title: string; weight: string }> = [
  { key: "price", title: "Price action", weight: "35%" },
  { key: "volume", title: "Volume (accumulation / distribution)", weight: "15%" },
  { key: "news", title: "News (India + global)", weight: "30%" },
  { key: "social", title: "Social & forums", weight: "20%" },
];
type SortKey = "weight" | "score" | "change" | "contribution";
type Filter = "ALL" | "BULLISH" | "BEARISH" | "NEUTRAL";

const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`);
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();

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

function IndexCard({ reading, active, onSelect }: { reading: IndexSentimentReading; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`isa-card${active ? " active" : ""}`} onClick={onSelect} aria-pressed={active}>
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
}

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
          5-day {signed(stock.five_day_pct, 1)}% · vs 20-DMA {signed(stock.vs_20dma_pct, 1)}% · volume {stock.volume_ratio === null ? "--" : `${stock.volume_ratio.toFixed(1)}x avg`} · {stock.news_count} news / {stock.social_count} forum mentions · confidence {stock.confidence.toLowerCase()}
          {stock.social_raw !== null && stock.social_raw !== stock.components.social ? ` · raw forum mood ${signed(stock.social_raw)} (damped: crowded trade)` : ""}
        </p>
      </div>
      <div>
        {stock.notes.length ? <ul className="isa-notes">{stock.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        {stock.headlines.length ? (
          <ul className="isa-headlines">
            {stock.headlines.map((headline) => (
              <li key={headline.link + headline.title}>
                <b className={tone(headline.score)}>{signed(headline.score)}</b>
                <a href={headline.link} target="_blank" rel="noreferrer">{headline.title}</a>
                <small>{headline.source} · {headline.age_hours.toFixed(0)}h ago</small>
              </li>
            ))}
          </ul>
        ) : <p className="isa-muted">No recent news or forum chatter on this stock: reading is price and volume only.</p>}
      </div>
    </div>
  );
}

function ConstituentTable({ reading }: { reading: IndexSentimentReading }) {
  const [sort, setSort] = useState<SortKey>("weight");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = reading.constituents.filter((stock) => {
      if (needle && !`${stock.symbol} ${stock.name} ${stock.sector}`.toLowerCase().includes(needle)) return false;
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
          <option value="ALL">All</option><option value="BULLISH">Bullish</option><option value="NEUTRAL">Neutral</option><option value="BEARISH">Bearish</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort constituents">
          <option value="weight">Sort: index weight</option><option value="score">Sort: sentiment score</option><option value="change">Sort: day change</option><option value="contribution">Sort: impact on index</option>
        </select>
      </div>
      <div className="isa-table-wrap">
        <table className="isa-table">
          <thead><tr><th>Stock</th><th>Weight</th><th>Price</th><th>Day</th><th>Vol</th><th className="isa-col-bar">Sentiment</th><th>Score</th><th>Impact</th></tr></thead>
          <tbody>
            {rows.map((stock) => (
              <Fragment key={stock.symbol}>
                <tr className={open === stock.symbol ? "open" : ""} onClick={() => setOpen(open === stock.symbol ? null : stock.symbol)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === stock.symbol ? null : stock.symbol); } }} aria-expanded={open === stock.symbol}>
                  <td><b>{stock.symbol}</b><small>{stock.name} · {stock.sector}</small></td>
                  <td>{stock.weight.toFixed(1)}%</td>
                  <td>{stock.price === null ? "--" : stock.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                  <td className={tone((stock.change_pct ?? 0) * 20)}>{signed(stock.change_pct, 2)}%</td>
                  <td className={stock.volume_ratio !== null && stock.volume_ratio >= 1.5 ? "isa-hot" : ""}>{stock.volume_ratio === null ? "--" : `${stock.volume_ratio.toFixed(1)}x`}</td>
                  <td className="isa-col-bar"><ScoreBar score={stock.score} /><small className={tone(stock.score)}>{words(stock.label)}</small></td>
                  <td><b className={tone(stock.score)}>{signed(stock.score)}</b></td>
                  <td className={tone((stock.contribution ?? 0) * 10)}>{signed(stock.contribution, 1)}</td>
                </tr>
                {open === stock.symbol ? <tr className="isa-detail-row"><td colSpan={8}><ConstituentDetail stock={stock} /></td></tr> : null}
              </Fragment>
            ))}
            {rows.length === 0 ? <tr><td colSpan={8} className="isa-muted">No constituents match.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <small className="isa-muted">Impact = index weight × score: the points this stock adds to or takes from the index reading. Click a row for the price, volume, news and social breakdown.</small>
    </section>
  );
}

function IndexDetail({ reading }: { reading: IndexSentimentReading }) {
  const lens = reading.lenses;
  return (
    <>
      <section className="isa-grid">
        <div className="isa-panel">
          <h3>Market psychology read</h3>
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
      <ConstituentTable reading={reading} />
    </>
  );
}

export default function OperationsPage() {
  const [data, setData] = useState<IndexSentiment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<IndexId | null>("NIFTY");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/index-sentiment${force ? "?refresh=1" : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error ?? "Index sentiment unavailable");
      setData(body as IndexSentiment);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Index sentiment unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const reading = data?.indices.find((index) => index.id === selected) ?? null;
  return (
    <main className="isa-page">
      <header className="isa-header">
        <div>
          <p className="isa-kicker">MARKET PSYCHOLOGY DESK</p>
          <h1>Index Sentiment Analyser</h1>
          <p className="isa-muted">NIFTY 50, BANK NIFTY and SENSEX read bottom-up from every constituent: free-float weight, price action, volume, Indian and global news, and retail forums.</p>
        </div>
        <div className="isa-actions">
          <button type="button" onClick={() => void load(true)} disabled={loading}>{loading ? "Scanning…" : "Refresh"}</button>
          {data ? <small>Updated {new Date(data.generated_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST</small> : null}
          <a href="/">Back to dashboard</a>
        </div>
      </header>

      {error ? <p className="isa-alert">{error}{data ? " (showing the last good scan)" : ""}</p> : null}
      {!data && !error ? <p className="isa-panel isa-muted">Scanning 60+ stocks, per-company news and forums… the first scan can take up to a minute.</p> : null}

      {data ? (
        <>
          <section className="isa-cards">
            {data.indices.map((index) => <IndexCard key={index.id} reading={index} active={index.id === selected} onSelect={() => setSelected(selected === index.id ? null : index.id)} />)}
          </section>
          {reading ? <IndexDetail reading={reading} /> : <p className="isa-muted">Select an index to see its constituents.</p>}
          <section className="isa-panel isa-sources">
            <h3>Data sources</h3>
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
