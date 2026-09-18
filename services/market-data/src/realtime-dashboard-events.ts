import type { EventEnvelope } from "../../../packages/event-schemas/src/events";
import { isUnsafeEvent } from "../../../packages/event-schemas/src/events";

export function dashboardEventState(events: EventEnvelope[]) { return { events, unsafe: events.some(isUnsafeEvent), latest: events.at(-1) }; }