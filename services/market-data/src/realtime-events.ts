import type { EventEnvelope } from "../../../packages/event-schemas/src/events";

type Listener = (event: EventEnvelope) => void;
const listeners = new Set<Listener>();

export function subscribeToRealtimeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishRealtimeEvent(event: EventEnvelope): void {
  for (const listener of listeners) listener(event);
}