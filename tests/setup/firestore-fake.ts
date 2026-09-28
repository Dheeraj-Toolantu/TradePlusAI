// Global test isolation: every test runs against an in-memory Firestore fake.
// Without this, importing apps/web/lib/firestore-orders talks to the real
// Firebase project baked into apps/web/lib/firebase.ts, so unit tests wrote
// paper orders into production data and read back leftovers from earlier runs.
import { beforeEach, vi } from "vitest";

type Data = Record<string, unknown>;
type Constraint = { kind: "where"; field: string; op: string; value: unknown } | { kind: "limit"; count: number } | { kind: "orderBy" };
type CollectionRef = { kind: "collection"; path: string };
type DocRef = { kind: "doc"; path: string; id: string };
type QueryRef = { kind: "query"; path: string; constraints: Constraint[] };

const collections = new Map<string, Map<string, Data>>();
const bucket = (path: string) => {
  let store = collections.get(path);
  if (!store) collections.set(path, (store = new Map()));
  return store;
};
const snapshotOf = (id: string, data: Data | undefined) => ({ id, exists: () => data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) });
const matches = (data: Data, constraint: Constraint) => {
  if (constraint.kind !== "where") return true;
  const actual = data[constraint.field];
  if (constraint.op === "==") return actual === constraint.value;
  if (constraint.op === "in") return Array.isArray(constraint.value) && constraint.value.includes(actual);
  throw new Error(`firestore-fake: unsupported operator ${constraint.op}`);
};

export const firestoreFake = {
  reset: () => collections.clear(),
  documents: (path: string) => Array.from(bucket(path).entries()).map(([id, data]) => ({ id, ...structuredClone(data) })),
};

vi.mock("firebase/firestore", () => ({
  getFirestore: () => ({ fake: true }),
  collection: (_db: unknown, path: string): CollectionRef => ({ kind: "collection", path }),
  doc: (_db: unknown, path: string, id: string): DocRef => ({ kind: "doc", path, id }),
  query: (ref: CollectionRef, ...constraints: Constraint[]): QueryRef => ({ kind: "query", path: ref.path, constraints }),
  where: (field: string, op: string, value: unknown): Constraint => ({ kind: "where", field, op, value }),
  limit: (count: number): Constraint => ({ kind: "limit", count }),
  orderBy: (): Constraint => ({ kind: "orderBy" }),
  serverTimestamp: () => ({ serverTimestamp: true }),
  setDoc: async (ref: DocRef, data: Data) => { bucket(ref.path).set(ref.id, structuredClone(data)); },
  updateDoc: async (ref: DocRef, data: Data) => {
    const store = bucket(ref.path);
    const existing = store.get(ref.id);
    if (!existing) throw Object.assign(new Error(`No document to update: ${ref.path}/${ref.id}`), { code: "not-found" });
    store.set(ref.id, { ...existing, ...structuredClone(data) });
  },
  deleteDoc: async (ref: DocRef) => { bucket(ref.path).delete(ref.id); },
  getDoc: async (ref: DocRef) => snapshotOf(ref.id, bucket(ref.path).get(ref.id)),
  getDocs: async (ref: CollectionRef | QueryRef) => {
    const constraints = ref.kind === "query" ? ref.constraints : [];
    const max = constraints.find((item): item is Extract<Constraint, { kind: "limit" }> => item.kind === "limit")?.count ?? Infinity;
    const docs = Array.from(bucket(ref.path).entries())
      .filter(([, data]) => constraints.every((constraint) => matches(data, constraint)))
      .slice(0, max)
      .map(([id, data]) => snapshotOf(id, data));
    return { docs, empty: docs.length === 0, size: docs.length };
  },
}));

vi.mock("firebase/analytics", () => ({ getAnalytics: () => null, isSupported: async () => false }));

beforeEach(async () => {
  firestoreFake.reset();
  const { clearLocalOrderStore } = await import("../../apps/web/lib/firestore-orders");
  clearLocalOrderStore();
});
