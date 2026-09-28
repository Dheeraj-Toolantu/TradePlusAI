import { GrowwAdapter, createGrowwTransport } from "../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../adapters/groww/src/groww-instruments";
import { getAllOrdersFromFirestore, saveOrderToFirestore } from "../firestore-orders";
import { LiveTradingService, type LiveDeps } from "./service";

function payloadOf(value: unknown): Record<string, unknown> {
  return ((value as { payload?: Record<string, unknown> })?.payload ?? {}) as Record<string, unknown>;
}

export function productionLiveDeps(environment: NodeJS.ProcessEnv = process.env): LiveDeps {
  const transport = createGrowwTransport(environment);
  return {
    broker: new GrowwAdapter(transport),
    async ltp(symbol, exchange) {
      const body = await transport.request(`/v1/live-data/quote?exchange=${exchange}&segment=FNO&trading_symbol=${encodeURIComponent(symbol)}`, { method: "GET" });
      const payload = payloadOf(body);
      const price = Number(payload.ltp ?? payload.last_price ?? payload.lastPrice);
      return Number.isFinite(price) && price > 0 ? price : null;
    },
    async instrument(symbol) {
      const catalog = await loadGrowwInstrumentCatalog();
      return catalog.getByTradingSymbol("NSE", symbol) ?? catalog.getByTradingSymbol("BSE", symbol);
    },
    store: {
      save: saveOrderToFirestore,
      async listLive() { return (await getAllOrdersFromFirestore(300)).filter((order) => order.mode === "ALGO_LIVE"); },
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: environment,
  };
}

export const liveService = () => new LiveTradingService(productionLiveDeps());
