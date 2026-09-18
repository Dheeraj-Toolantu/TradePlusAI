import type { EventEnvelope } from "../../../packages/event-schemas/src/events";
import { dashboardEventState } from "../../../services/market-data/src/realtime-dashboard-events";

export function consumeDashboardEvents(events: EventEnvelope[]) { return dashboardEventState(events); }