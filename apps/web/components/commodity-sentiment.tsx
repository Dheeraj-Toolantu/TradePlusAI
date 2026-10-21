"use client";

import { memo } from "react";
import type { CommodityReading, CommoditySentiment } from "../lib/commodity-sentiment";

const tone = (score: number | null | undefined) => (score === null || score === undefined ? "isa-muted" : score >= 12 ? "isa-up" : score <= -12 ? "isa-down" : "isa-flat");
const signed = (value: number | null | undefined, digits = 0) => {
  if (value === null || value === undefined) return "--";
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? text : `${value > 0 ? "+" : "-"}${text}`; // never "-0"
};
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();
const LENS_LABEL = { price: "Today", trend: "Trend", news: "News" } as const;

function Card({ item }: { item: CommodityReading }) {
  const width = item.score === null ? 0 : Math.min(100, Math.abs(item.score)) / 2;
  return (
    <div className="isa-card cms-card">
      <div className="isa-card-head">
        <b>{item.name}</b>
        {item.price !== null ? <span className={tone((item.change_pct ?? 0) * 20)}>{item.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })} {item.unit} ({signed(item.change_pct, 2)}%)</span> : <span className="isa-muted">no price</span>}
      </div>
      <div className="isa-card-score">
        <strong className={tone(item.score)}>{signed(item.score)}</strong>
        <div><em className={tone(item.score)}>{words(item.label)}</em><small>For India: <b className={tone(item.india_impact)}>{words(item.india_label)}</b></small></div>
      </div>
      <div className="isa-bar" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={item.score ?? undefined} aria-label={`${item.name} sentiment`}>
        <span className="isa-bar-mid" />
        {item.score !== null ? <i className={item.score >= 0 ? "isa-fill-up" : "isa-fill-down"} style={{ width: `${width}%`, left: item.score >= 0 ? "50%" : `${50 - width}%` }} /> : null}
      </div>
      <small className="cms-lenses">{(Object.keys(LENS_LABEL) as Array<keyof typeof LENS_LABEL>).map((key) => <span key={key}>{LENS_LABEL[key]} <b className={tone(item.lenses[key])}>{signed(item.lenses[key])}</b></span>)} · 5-day {signed(item.five_day_pct, 1)}%</small>
      {item.headlines[0] ? <a className="cms-headline" href={item.headlines[0].link} target="_blank" rel="noreferrer" title={item.headlines.map((line) => line.title).join("\n")}>{item.headlines[0].title}</a> : <small className="isa-muted">No fresh headlines</small>}
    </div>
  );
}

/** Crude oil, natural gas, gold, silver and copper: each commodity's own sentiment and what it means for Indian equities. */
export const CommoditySentimentDesk = memo(function CommoditySentimentDesk({ data }: { data: CommoditySentiment }) {
  return (
    <section className="isa-panel cms">
      <div className="ce-head">
        <h3>Commodity sentiment</h3>
        <span className="isa-muted">Crude oil · natural gas · gold · silver · copper</span>
      </div>
      <div className="isa-cards">{data.commodities.map((item) => <Card key={item.id} item={item} />)}</div>
      {data.notes.length ? <ul className="isa-notes">{data.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      <small className="isa-muted">{data.method}</small>
    </section>
  );
});
