import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import type { SmcStructure } from "../../lib/smc-structure";

/** Which SMC layers are drawn (all independently switchable on the page). */
export type StructureLayers = { swings: boolean; structure: boolean; inducement: boolean; sweeps: boolean; liquidity: boolean; ob: boolean; fvg: boolean; pd: boolean };
export const ALL_LAYERS: StructureLayers = { swings: true, structure: true, inducement: true, sweeps: true, liquidity: true, ob: true, fvg: true, pd: false };

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

// Bullish = cyan, bearish = magenta (distinct from the green/red candles); MSS amber, IDM violet,
// liquidity grey-white. Every element also carries a text label, so colour is never the only cue.
const BULL = { fill: "rgba(48, 212, 202, 0.10)", ob: "rgba(48, 212, 202, 0.17)", edge: "rgba(48, 212, 202, 0.85)", text: "#7fe8e0" };
const BEAR = { fill: "rgba(224, 92, 168, 0.10)", ob: "rgba(224, 92, 168, 0.17)", edge: "rgba(224, 92, 168, 0.85)", text: "#f2a3d0" };
const MSS = { edge: "rgba(240, 195, 107, 0.95)", text: "#f0c36b" };
const IDM = { edge: "rgba(176, 148, 255, 0.85)", text: "#c7b5ff" };
const LIQ = { line: "rgba(214, 226, 228, 0.7)", text: "#d6e2e4", faded: "rgba(214, 226, 228, 0.35)" };
const LABEL_BG = "rgba(8, 28, 36, 0.78)";

export class SmcStructurePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private data: SmcStructure | null = null;
  private lastIndex = 0;
  private layers: StructureLayers = { ...ALL_LAYERS };
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => "top", renderer: () => renderer };
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) { this.chart = param.chart; this.series = param.series; this.requestUpdate = param.requestUpdate; }
  detached() { this.chart = null; this.series = null; this.requestUpdate = null; }
  set(data: SmcStructure | null, lastIndex: number, layers: StructureLayers) { this.data = data; this.lastIndex = lastIndex; this.layers = layers; this.requestUpdate?.(); }
  paneViews() { return [this.view]; }

  private draw(target: DrawTarget) {
    const chart = this.chart; const series = this.series; const data = this.data;
    if (!chart || !series || !data) return;
    const L = this.layers;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const time = chart.timeScale();
      const half = time.options().barSpacing / 2;
      const x = (index: number) => time.logicalToCoordinate(index as Logical);
      const y = (price: number) => series.priceToCoordinate(price);
      const visible = (x1: number, x2: number) => x2 >= -20 && x1 <= mediaSize.width + 20;
      const end = (index: number | null) => x(index ?? this.lastIndex);
      ctx.save();
      ctx.font = "600 10px 'DM Mono', monospace";
      ctx.textBaseline = "middle";
      const label = (text: string, px: number, py: number, color: string, align: "left" | "center" = "center") => {
        const w = ctx.measureText(text).width;
        const left = align === "center" ? px - w / 2 : px;
        ctx.fillStyle = LABEL_BG; ctx.fillRect(left - 2, py - 6, w + 4, 12);
        ctx.fillStyle = color; ctx.fillText(text, left, py);
      };

      // Premium / discount of the latest swing range, behind everything else.
      if (L.pd && data.premiumDiscount) {
        const pd = data.premiumDiscount;
        const x1 = x(pd.fromIndex); const x2 = x(this.lastIndex); const top = y(pd.high); const eq = y(pd.equilibrium); const bottom = y(pd.low);
        if (x1 !== null && x2 !== null && top !== null && eq !== null && bottom !== null) {
          ctx.fillStyle = "rgba(224, 92, 168, 0.05)"; ctx.fillRect(x1, top, x2 + half - x1, eq - top);
          ctx.fillStyle = "rgba(48, 212, 202, 0.05)"; ctx.fillRect(x1, eq, x2 + half - x1, bottom - eq);
          ctx.strokeStyle = "rgba(214, 226, 228, 0.45)"; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(x1, eq); ctx.lineTo(x2 + half, eq); ctx.stroke(); ctx.setLineDash([]);
          label("Premium", x2 + half - 30, top + 9, BEAR.text); label("EQ 50%", x2 + half - 26, eq - 8, LIQ.text); label("Discount", x2 + half - 30, bottom - 9, BULL.text);
        }
      }

      const zone = (z: SmcStructure["fvgs"][number]) => {
        const x1r = x(z.fromIndex); const x2r = end(z.endIndex); const top = y(z.top); const bottom = y(z.bottom);
        if (x1r === null || x2r === null || top === null || bottom === null) return;
        const x1 = x1r - half; const x2 = x2r + half;
        if (!visible(x1, x2)) return;
        const p = z.dir === "bull" ? BULL : BEAR;
        const h = Math.max(1, bottom - top);
        ctx.globalAlpha = z.state === "ACTIVE" ? 1 : 0.45;
        ctx.fillStyle = z.kind === "OB" ? p.ob : p.fill; ctx.fillRect(x1, top, x2 - x1, h);
        ctx.strokeStyle = p.edge; ctx.lineWidth = 1; if (z.kind === "FVG") ctx.setLineDash([3, 3]);
        ctx.strokeRect(x1 + 0.5, top + 0.5, x2 - x1 - 1, h - 1); ctx.setLineDash([]);
        if (x2 - x1 > 30 && h > 9) { ctx.fillStyle = p.text; ctx.fillText(`${z.dir === "bull" ? "Bull" : "Bear"} ${z.kind}${z.state === "MITIGATED" ? " (m)" : ""}`, Math.max(x1, 2) + 3, top + Math.min(h / 2, 8)); }
        ctx.globalAlpha = 1;
      };
      if (L.fvg) data.fvgs.forEach(zone);
      if (L.ob) data.orderBlocks.forEach(zone);

      if (L.liquidity) {
        for (const l of data.liquidity) {
          const x1 = x(l.fromIndex); const x2 = end(l.endIndex); const py = y(l.price);
          if (x1 === null || x2 === null || py === null || !visible(x1, x2)) continue;
          const open = l.outcome === "OPEN";
          ctx.strokeStyle = open ? LIQ.line : LIQ.faded; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(x1, py); ctx.lineTo(x2 + (open ? half : 0), py); ctx.stroke(); ctx.setLineDash([]);
          const name = l.equal ? (l.side === "BSL" ? "EQH" : "EQL") : l.side;
          ctx.fillStyle = open ? LIQ.text : LIQ.faded;
          ctx.fillText(`${name}${open ? "" : l.outcome === "SWEPT" ? " swept" : " grabbed"}`, x2 + half + 3, py + (l.side === "BSL" ? -6 : 6));
        }
      }

      if (L.inducement) {
        for (const idm of data.inducements) {
          const x1 = x(idm.index); const x2 = end(idm.takenIndex); const py = y(idm.price);
          if (x1 === null || x2 === null || py === null || !visible(x1, x2)) continue;
          ctx.strokeStyle = IDM.edge; ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
          ctx.beginPath(); ctx.moveTo(x1, py); ctx.lineTo(x2, py); ctx.stroke(); ctx.setLineDash([]);
          label(idm.takenIndex === null ? "IDM" : "IDM ✓", (x1 + x2) / 2, py + (idm.dir === "bull" ? 8 : -8), IDM.text);
        }
      }

      if (L.structure) {
        for (const e of data.events) {
          const x1 = x(e.fromIndex); const x2 = x(e.index); const py = y(e.price);
          if (x1 === null || x2 === null || py === null || !visible(x1, x2)) continue;
          const p = e.dir === "bull" ? BULL : BEAR;
          const color = e.kind === "MSS" ? MSS.edge : p.edge;
          ctx.strokeStyle = color; ctx.lineWidth = e.kind === "BOS" ? 1 : 1.6;
          if (e.kind === "CHoCH") ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(x1, py); ctx.lineTo(x2, py); ctx.stroke(); ctx.setLineDash([]);
          label(e.kind, (x1 + x2) / 2, py + (e.dir === "bull" ? -8 : 8), e.kind === "MSS" ? MSS.text : p.text);
        }
      }

      if (L.sweeps) {
        for (const ev of data.liquidityEvents) {
          const px = x(ev.index); const py = y(ev.extreme); const lvl = y(ev.price);
          if (px === null || py === null || lvl === null || !visible(px, px)) continue;
          const up = ev.side === "BSL";
          ctx.strokeStyle = MSS.edge; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px - half, lvl); ctx.lineTo(px + half, lvl); ctx.stroke();
          ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.stroke();
          label(ev.kind === "SWEEP" ? (up ? "Sweep ▲" : "Sweep ▼") : (up ? "Grab ▲" : "Grab ▼"), px, py + (up ? -12 : 12), MSS.text);
        }
      }

      if (L.swings) {
        for (const s of data.swings) {
          const px = x(s.index); const py = y(s.price);
          if (px === null || py === null || !visible(px, px)) continue;
          const high = s.kind === "HIGH";
          const good = s.label === "HH" || s.label === "HL";
          const bad = s.label === "LH" || s.label === "LL";
          const color = good ? BULL.text : bad ? BEAR.text : LIQ.text;
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py + (high ? -3 : 3), 2, 0, Math.PI * 2); ctx.fill();
          label(s.label, px, py + (high ? -14 : 14), color);
        }
      }
      ctx.restore();
    });
  }
}
