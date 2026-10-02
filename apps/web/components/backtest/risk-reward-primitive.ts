import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

/**
 * TradingView-style long/short position boxes: the risk zone (entry → stop) and the reward zone
 * (entry → T2, with a T1 line) drawn from the entry candle to the exit candle, labelled with the
 * planned risk:reward and, once closed, the realised R.
 */
export type RiskRewardBox = {
  id: number;
  long: boolean;
  /** Logical bar indexes on the chart (fractional is fine). */
  fromIndex: number;
  toIndex: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  /** Realised R when the trade is closed; null while it is open (replay). */
  resultR: number | null;
  /** Live R of an open trade (replay), shown instead of the result. */
  liveR?: number | null;
  focused: boolean;
};

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

const RISK_FILL = "rgba(214, 116, 60, 0.20)";
const RISK_EDGE = "rgba(214, 116, 60, 0.75)";
const REWARD_FILL = "rgba(61, 147, 214, 0.18)";
const REWARD_EDGE = "rgba(61, 147, 214, 0.75)";

export class RiskRewardPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private boxes: RiskRewardBox[] = [];
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => "bottom", renderer: () => renderer };
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() { this.chart = null; this.series = null; this.requestUpdate = null; }

  setBoxes(boxes: RiskRewardBox[]) { this.boxes = boxes; this.requestUpdate?.(); }

  paneViews() { return [this.view]; }

  private draw(target: DrawTarget) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.boxes.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const time = chart.timeScale();
      const spacing = time.options().barSpacing;
      for (const box of this.boxes) {
        const x1raw = time.logicalToCoordinate(box.fromIndex as Logical);
        const x2raw = time.logicalToCoordinate(box.toIndex as Logical);
        const yEntry = series.priceToCoordinate(box.entry);
        const yStop = series.priceToCoordinate(box.stop);
        const yT1 = series.priceToCoordinate(box.target1);
        const yT2 = series.priceToCoordinate(box.target2);
        if (x1raw === null || x2raw === null || yEntry === null || yStop === null || yT1 === null || yT2 === null) continue;
        const x1 = x1raw - spacing / 2;
        const x2 = Math.max(x2raw + spacing / 2, x1 + 6);
        if (x2 < 0 || x1 > mediaSize.width) continue;
        const width = x2 - x1;
        const alpha = box.focused ? 1 : 0.55;
        ctx.save();
        ctx.globalAlpha = alpha;
        // Zones.
        ctx.fillStyle = RISK_FILL; ctx.fillRect(x1, Math.min(yEntry, yStop), width, Math.abs(yStop - yEntry));
        ctx.fillStyle = REWARD_FILL; ctx.fillRect(x1, Math.min(yEntry, yT2), width, Math.abs(yT2 - yEntry));
        ctx.lineWidth = 1;
        ctx.strokeStyle = RISK_EDGE; ctx.strokeRect(x1 + 0.5, Math.min(yEntry, yStop) + 0.5, width - 1, Math.abs(yStop - yEntry) - 1);
        ctx.strokeStyle = REWARD_EDGE; ctx.strokeRect(x1 + 0.5, Math.min(yEntry, yT2) + 0.5, width - 1, Math.abs(yT2 - yEntry) - 1);
        // Entry line (solid) and T1 line (dashed).
        ctx.strokeStyle = "rgba(228, 241, 241, 0.9)"; ctx.beginPath(); ctx.moveTo(x1, yEntry); ctx.lineTo(x2, yEntry); ctx.stroke();
        ctx.setLineDash([4, 3]); ctx.strokeStyle = REWARD_EDGE; ctx.beginPath(); ctx.moveTo(x1, yT1); ctx.lineTo(x2, yT1); ctx.stroke(); ctx.setLineDash([]);
        // Labels (only when there is room, always for the focused trade).
        if (box.focused || width > 70) {
          const risk = Math.abs(box.entry - box.stop) || 1;
          const rr1 = Math.abs(box.target1 - box.entry) / risk;
          const rr2 = Math.abs(box.target2 - box.entry) / risk;
          ctx.globalAlpha = 1;
          ctx.font = "600 11px 'DM Mono', monospace";
          const label = (text: string, y: number, color: string, above: boolean) => {
            const padX = 5; const height = 16;
            const textWidth = ctx.measureText(text).width;
            // Keep clear of the OHLC readout across the top of the chart.
            const top = Math.max(26, above ? y - height - 2 : y + 2);
            ctx.fillStyle = "rgba(8, 28, 36, 0.85)"; ctx.fillRect(x1 + 2, top, textWidth + padX * 2, height);
            ctx.fillStyle = color; ctx.fillText(text, x1 + 2 + padX, top + 12);
          };
          const rewardAbove = box.long;
          label(`#${box.id} R:R 1:${rr2.toFixed(1)} (T1 ${rr1.toFixed(1)}R)`, yT2, "#9fd0f5", rewardAbove);
          label(`risk ${risk.toFixed(1)} pts`, yStop, "#f0a57a", !rewardAbove);
          const outcome = box.resultR !== null ? `${box.resultR >= 0 ? "+" : "−"}${Math.abs(box.resultR).toFixed(2)}R` : box.liveR !== undefined && box.liveR !== null ? `open ${box.liveR >= 0 ? "+" : "−"}${Math.abs(box.liveR).toFixed(2)}R` : null;
          if (outcome) {
            ctx.font = "700 11px 'DM Mono', monospace";
            const textWidth = ctx.measureText(outcome).width;
            const x = Math.max(x1 + 2, x2 - textWidth - 12);
            const y = yEntry + (rewardAbove ? 4 : -20);
            const positive = box.resultR !== null ? box.resultR >= 0 : (box.liveR ?? 0) >= 0;
            ctx.fillStyle = "rgba(8, 28, 36, 0.85)"; ctx.fillRect(x, y, textWidth + 10, 16);
            ctx.fillStyle = positive ? "#9fd0f5" : "#f0a57a"; ctx.fillText(outcome, x + 5, y + 12);
          }
        }
        ctx.restore();
      }
    });
  }
}
