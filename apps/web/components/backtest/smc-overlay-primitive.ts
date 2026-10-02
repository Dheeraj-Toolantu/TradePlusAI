import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import type { SmcOverlays } from "./smc-overlays";

export type SmcLayers = { fvg: boolean; ob: boolean; liquidity: boolean; structure: boolean };

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

// Bullish = cyan, bearish = magenta: distinct from the green/red candles and the blue/orange
// risk:reward boxes. Every element also carries a text label, so colour is never the only cue.
const BULL = { fill: "rgba(48, 212, 202, 0.12)", obFill: "rgba(48, 212, 202, 0.18)", edge: "rgba(48, 212, 202, 0.8)", text: "#7fe8e0" };
const BEAR = { fill: "rgba(224, 92, 168, 0.12)", obFill: "rgba(224, 92, 168, 0.18)", edge: "rgba(224, 92, 168, 0.8)", text: "#f2a3d0" };
const LIQ = { line: "rgba(214, 226, 228, 0.7)", text: "#d6e2e4", swept: "rgba(214, 226, 228, 0.35)" };

/** Draws FVGs, order blocks, liquidity lines and BOS/CHoCH from {@link SmcOverlays}. */
export class SmcOverlayPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private overlays: SmcOverlays = { fvgs: [], orderBlocks: [], liquidity: [], structure: [] };
  private layers: SmcLayers = { fvg: true, ob: true, liquidity: true, structure: true };
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => "bottom", renderer: () => renderer };
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) { this.chart = param.chart; this.series = param.series; this.requestUpdate = param.requestUpdate; }
  detached() { this.chart = null; this.series = null; this.requestUpdate = null; }
  set(overlays: SmcOverlays, layers: SmcLayers) { this.overlays = overlays; this.layers = layers; this.requestUpdate?.(); }
  paneViews() { return [this.view]; }

  private draw(target: DrawTarget) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    const { fvg, ob, liquidity, structure } = this.layers;
    if (!fvg && !ob && !liquidity && !structure) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const time = chart.timeScale();
      const half = time.options().barSpacing / 2;
      const x = (index: number) => time.logicalToCoordinate(index as Logical);
      const y = (price: number) => series.priceToCoordinate(price);
      const visible = (x1: number, x2: number) => x2 >= 0 && x1 <= mediaSize.width;
      ctx.save();
      ctx.font = "600 10px 'DM Mono', monospace";
      ctx.textBaseline = "middle";

      const zone = (item: SmcOverlays["fvgs"][number]) => {
        const x1raw = x(item.fromIndex); const x2raw = x(item.toIndex);
        const top = y(item.top); const bottom = y(item.bottom);
        if (x1raw === null || x2raw === null || top === null || bottom === null) return;
        const x1 = x1raw - half; const x2 = x2raw + half;
        if (!visible(x1, x2)) return;
        const palette = item.dir === "bull" ? BULL : BEAR;
        const h = Math.max(1, bottom - top);
        ctx.globalAlpha = item.active ? 1 : 0.45;
        ctx.fillStyle = item.kind === "OB" ? palette.obFill : palette.fill;
        ctx.fillRect(x1, top, x2 - x1, h);
        ctx.strokeStyle = palette.edge; ctx.lineWidth = 1;
        if (item.kind === "FVG") ctx.setLineDash([3, 3]);
        ctx.strokeRect(x1 + 0.5, top + 0.5, x2 - x1 - 1, h - 1);
        ctx.setLineDash([]);
        if (x2 - x1 > 26 && h > 9) { ctx.fillStyle = palette.text; ctx.fillText(`${item.dir === "bull" ? "Bull" : "Bear"} ${item.kind}`, Math.max(x1, 2) + 3, top + Math.min(h / 2, 8)); }
        ctx.globalAlpha = 1;
      };
      if (fvg) for (const item of this.overlays.fvgs) zone(item);
      if (ob) for (const item of this.overlays.orderBlocks) zone(item);

      if (liquidity) {
        for (const line of this.overlays.liquidity) {
          const x1raw = x(line.fromIndex); const x2raw = x(line.toIndex); const py = y(line.price);
          if (x1raw === null || x2raw === null || py === null) continue;
          if (!visible(x1raw, x2raw + half)) continue;
          ctx.strokeStyle = line.swept ? LIQ.swept : LIQ.line; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(x1raw, py); ctx.lineTo(x2raw + (line.swept ? 0 : half), py); ctx.stroke(); ctx.setLineDash([]);
          const label = `${line.equal ? (line.dir === "BSL" ? "EQH" : "EQL") : line.dir}${line.swept ? " ✕" : ""}`;
          ctx.fillStyle = line.swept ? LIQ.swept : LIQ.text;
          ctx.fillText(label, x2raw + half + 3, py + (line.dir === "BSL" ? -6 : 6));
        }
      }

      if (structure) {
        for (const item of this.overlays.structure) {
          const x1 = x(item.fromIndex); const x2 = x(item.toIndex); const py = y(item.price);
          if (x1 === null || x2 === null || py === null || !visible(x1, x2)) continue;
          const palette = item.dir === "bull" ? BULL : BEAR;
          ctx.strokeStyle = palette.edge; ctx.lineWidth = item.kind === "CHoCH" ? 1.5 : 1;
          if (item.kind === "CHoCH") ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(x1, py); ctx.lineTo(x2, py); ctx.stroke(); ctx.setLineDash([]);
          const text = item.kind;
          const width = ctx.measureText(text).width;
          const mid = (x1 + x2) / 2 - width / 2;
          const ty = py + (item.dir === "bull" ? -7 : 7);
          ctx.fillStyle = "rgba(8, 28, 36, 0.75)"; ctx.fillRect(mid - 2, ty - 6, width + 4, 12);
          ctx.fillStyle = palette.text; ctx.fillText(text, mid, ty);
        }
      }
      ctx.restore();
    });
  }
}
