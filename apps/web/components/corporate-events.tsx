"use client";

import type { ConstituentSentiment, CorporateEvent, Deal, IndexSentimentReading } from "../lib/index-sentiment";

const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`);
const crore = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: value >= 100 ? 0 : 1 })} Cr`;
const when = (hours: number | null) => (hours === null ? "" : hours < 0 ? `in ${Math.ceil(-hours / 24)}d` : hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m ago` : hours < 48 ? `${hours.toFixed(0)}h ago` : `${Math.round(hours / 24)}d ago`);
const CLASS_LABEL: Record<Deal["class"], string> = { INSTITUTION: "Institution", PROMOTER: "Promoter", STRATEGIC: "PE / strategic", OTHER: "Other" };

/** Short chips for the constituents table: what happened or is coming. */
export function EventChips({ stock }: { stock: ConstituentSentiment }) {
  const types = new Set(stock.events.events.map((event) => event.type));
  const chips: Array<{ label: string; className: string }> = [];
  if (types.has("RESULTS")) chips.push({ label: "Results", className: "ce-chip" });
  if (types.has("DEALS") || types.has("BLOCK_DEAL")) chips.push({ label: "Block deal", className: "ce-chip" });
  if (types.has("REGULATORY") || types.has("AUDITOR_EXIT")) chips.push({ label: "Regulatory", className: "ce-chip ce-chip-risk" });
  if (types.has("ORDER_WIN")) chips.push({ label: "Order win", className: "ce-chip" });
  if (types.has("BUYBACK") || types.has("BONUS_SPLIT") || types.has("DIVIDEND") || types.has("DILUTION")) chips.push({ label: "Corp action", className: "ce-chip" });
  const due = stock.events.upcoming.find((row) => row.is_results);
  if (due) chips.push({ label: `Results ${due.days === 0 ? "today" : `in ${due.days}d`}`, className: "ce-chip ce-chip-due" });
  return chips.length ? <span className="ce-chips">{chips.map((chip) => <i key={chip.label} className={chip.className}>{chip.label}</i>)}</span> : null;
}

function EventList({ events, symbolOf }: { events: Array<CorporateEvent & { symbol?: string }>; symbolOf?: boolean }) {
  return (
    <ul className="ce-events">
      {events.map((event, index) => (
        <li key={`${event.type}-${event.title}-${index}`}>
          <b className={tone(event.impact)}>{signed(event.impact)}</b>
          <div>
            <span className="ce-type">{event.label}</span>{symbolOf && event.symbol ? <b className="ce-symbol">{event.symbol}</b> : null}
            {event.link ? <a href={event.link} target="_blank" rel="noreferrer">{event.title}</a> : <span>{event.title}</span>}
            <small>{event.source}{event.age_hours !== null ? ` · ${when(event.age_hours)}` : ""}</small>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DealsTable({ deals, showSymbol = false }: { deals: Array<Deal & { symbol?: string }>; showSymbol?: boolean }) {
  return (
    <div className="isa-table-wrap">
      <table className="isa-table ce-deals">
        <thead><tr>{showSymbol ? <th>Stock</th> : null}<th>Client</th><th>Side</th><th>Value</th><th>Price</th><th>Who</th><th>Deal</th></tr></thead>
        <tbody>
          {deals.map((deal, index) => (
            <tr key={`${deal.client}-${deal.side}-${index}`}>
              {showSymbol ? <td><b>{deal.symbol}</b></td> : null}
              <td title={deal.client}>{deal.client.length > 30 ? `${deal.client.slice(0, 30)}…` : deal.client}</td>
              <td className={deal.side === "BUY" ? "isa-up" : "isa-down"}>{deal.side}</td>
              <td>{crore(deal.value_cr)}<small>{deal.qty.toLocaleString("en-IN")} sh</small></td>
              <td>{deal.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}<small className={tone((deal.vs_price_pct ?? 0) * 10)}>{deal.vs_price_pct === null ? "" : `${signed(deal.vs_price_pct, 1)}% vs LTP`}</small></td>
              <td>{CLASS_LABEL[deal.class]}</td>
              <td>{deal.kind.toLowerCase()}<small>{deal.date ? new Date(deal.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : when(deal.age_hours)}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Corporate events block inside a stock's expanded row. */
export function StockEvents({ stock }: { stock: ConstituentSentiment }) {
  const { events, deals, upcoming } = stock.events;
  if (!events.length && !upcoming.length) return <p className="isa-muted">No block deals, results, filings or corporate actions in the window.</p>;
  return (
    <div className="ce-stock">
      {upcoming.length ? <p className="ce-upcoming">{upcoming.map((row) => `${row.is_results ? "Results" : row.purpose} on ${row.date}${row.days === 0 ? " (today)" : ` (in ${row.days}d)`}`).join(" · ")}</p> : null}
      {events.length ? <EventList events={events} /> : null}
      {deals ? (
        <>
          <small className="isa-muted">Block / bulk deals: buy {crore(deals.buy_value_cr)} vs sell {crore(deals.sell_value_cr)} · institutions bought {crore(deals.institution_buy_cr)} · promoters / PE sold {crore(deals.promoter_sell_cr)}</small>
          <DealsTable deals={deals.deals} />
        </>
      ) : null}
    </div>
  );
}

/** Index-wide corporate events: results season, deals, calendar and the events that matter most. */
export function IndexCorporatePanel({ reading }: { reading: IndexSentimentReading }) {
  const corporate = reading.corporate;
  const deals = corporate.deals;
  return (
    <section className="isa-panel ce-panel">
      <div className="ce-head">
        <h3>Corporate events, results &amp; block deals</h3>
        <span className="isa-muted">Events lens {signed(reading.lenses.events)} · results tone {signed(corporate.results_tone)} · {corporate.reporting_weight_7d.toFixed(0)}% of index weight reports in 7 days</span>
      </div>
      <div className="isa-grid ce-grid">
        <div>
          <h4>Results announced</h4>
          {corporate.results.length ? (
            <ul className="ce-results">{corporate.results.map((row) => <li key={row.symbol}><b>{row.symbol}</b><i>{row.weight.toFixed(1)}%</i><span className={tone(row.impact)}>{signed(row.impact)}</span><small title={row.title}>{row.title}</small></li>)}</ul>
          ) : <p className="isa-muted">No constituent results in the window.</p>}
          <h4>Upcoming (next 10 days)</h4>
          {corporate.upcoming.length ? (
            <ul className="ce-results">{corporate.upcoming.map((row) => <li key={`${row.symbol}-${row.date}`}><b>{row.symbol}</b><i>{row.weight.toFixed(1)}%</i><span className={row.is_results ? "isa-flat" : "isa-muted"}>{row.days === 0 ? "today" : `${row.days}d`}</span><small>{row.is_results ? "Results" : row.purpose} · {row.date}</small></li>)}</ul>
          ) : <p className="isa-muted">No board meetings or results scheduled for constituents (or NSE calendar unavailable).</p>}
        </div>
        <div>
          <h4>Most important events</h4>
          {corporate.notable.length ? <EventList events={corporate.notable} symbolOf /> : <p className="isa-muted">No scored corporate events in the window.</p>}
        </div>
      </div>
      <h4>Block &amp; bulk deals (last 7 days)</h4>
      {deals.count ? (
        <>
          <div className="isa-stats">
            <p><b className="isa-up">{crore(deals.buy_value_cr)}</b><small>bought</small></p>
            <p><b className="isa-down">{crore(deals.sell_value_cr)}</b><small>sold</small></p>
            <p><b className="isa-up">{crore(deals.institution_buy_cr)}</b><small>bought by institutions</small></p>
            <p><b className="isa-down">{crore(deals.promoter_sell_cr)}</b><small>sold by promoters / PE</small></p>
          </div>
          <DealsTable deals={deals.top} showSymbol />
        </>
      ) : <p className="isa-muted">No block or bulk deals in constituents over the last 7 days (or NSE deal data unavailable).</p>}
    </section>
  );
}
