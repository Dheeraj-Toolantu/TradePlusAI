import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";

export type OrderRecord = {
  id: string;
  symbol: string;
  growwSymbol?: string;
  expiry?: string;
  strike?: number;
  strategy?: string;
  strategyName?: string;
  side: "BUY" | "SELL" | string;
  quantity: number;
  lotSize?: number;
  price: number;
  target?: number;
  stopLoss?: number;
  minimumLossExitPrice?: number;
  maxProfitToTrail?: number;
  highWaterMark?: number;
  trailingStop?: number;
  trailingActivatedAt?: string;
  trailingDistance?: number;
  status: "OPEN" | "SIMULATED" | "FILLED" | "EXITED" | "CANCELLED";
  mode: "PAPER" | "ALGO_LIVE";
  source?: string;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  quoteSource?: string;
  createdAt: string;
  updatedAt?: string;
  exitPrice?: number;
  exitAt?: string;
  exitReason?: string;
  realizedPnl?: number;
  realizedPnlPercent?: number;
  brokerOrderId?: string;
};

const ORDERS_COLLECTION = "orders";
const LIVE_TRADE_COLLECTIONS = ["openTrade", "openTrades", "positionTrade", "positionTrades"];
const EXITED_TRADE_COLLECTIONS = ["ExitedTrade", "exitedTrade", "exitedTrades"];
const localOrderStore = new Map<string, OrderRecord>();

/** Test hook: drop the in-process order cache so each test starts from an empty book. */
export function clearLocalOrderStore(): void {
  localOrderStore.clear();
}

export function tradeCollectionsForStatus(status: string): string[] {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (["OPEN", "FILLED"].includes(normalized)) {
    return [ORDERS_COLLECTION, ...LIVE_TRADE_COLLECTIONS];
  }
  if (["EXITED", "CANCELLED"].includes(normalized)) {
    return [ORDERS_COLLECTION, ...EXITED_TRADE_COLLECTIONS];
  }
  return [ORDERS_COLLECTION];
}

const isLiveStatus = (status: unknown) => ["OPEN", "FILLED"].includes(String(status ?? "").trim().toUpperCase());

/**
 * An order lives in the live-trade collections only while it is OPEN/FILLED. Once it exits
 * (or is cancelled/simulated) those copies must be removed; otherwise they keep status OPEN
 * forever and get re-hydrated as phantom open positions.
 */
async function removeLiveCopies(orderId: string): Promise<void> {
  await Promise.all(LIVE_TRADE_COLLECTIONS.map(async (collectionName) => {
    try {
      await deleteDoc(doc(db, collectionName, orderId));
    } catch (err) {
      console.warn(`Failed to remove stale live copy ${collectionName}/${orderId}:`, err);
    }
  }));
}

function orderFromDocument(data: Record<string, unknown>, documentId: string): OrderRecord {
  return { ...data, id: String(data.id ?? documentId) } as OrderRecord;
}

function normalizeTradeSymbol(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

async function writeOrderToCollections(order: OrderRecord): Promise<void> {
  const collections = Array.from(new Set(tradeCollectionsForStatus(order.status)));
  const payload = {
    ...order,
    serverCreatedAt: serverTimestamp(),
    updatedAt: new Date().toISOString(),
  };

  for (const collectionName of collections) {
    try {
      const orderDocRef = doc(db, collectionName, order.id);
      await setDoc(orderDocRef, payload);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "permission-denied") {
        console.warn(
          `Firestore rules: Access denied for /${collectionName}/{orderId}. Update firestore.rules or enable read/write in Firebase Console.`
        );
      } else {
        console.warn(`Failed to write order to Firestore collection ${collectionName}:`, err);
      }
    }
  }
  if (!isLiveStatus(order.status)) await removeLiveCopies(order.id);
}

async function readCollectionOrders(collectionName: string, statuses: string[] = [], maxResults = 100): Promise<OrderRecord[]> {
  try {
    const ordersRef = collection(db, collectionName);
    const q = statuses.length > 0 ? query(ordersRef, where("status", "in", statuses), limit(maxResults)) : query(ordersRef, limit(maxResults));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((docSnap) => orderFromDocument(docSnap.data(), docSnap.id));
  } catch (err) {
    console.warn(`Could not query Firestore collection ${collectionName}:`, err);
    return [];
  }
}

export async function saveOrderToFirestore(order: OrderRecord): Promise<void> {
  localOrderStore.set(order.id, { ...order, updatedAt: new Date().toISOString() });
  await writeOrderToCollections(order);
}

export async function updateOrderInFirestore(
  orderId: string,
  updates: Partial<OrderRecord>
): Promise<void> {
  const existing = localOrderStore.get(orderId);
  if (existing) {
    localOrderStore.set(orderId, { ...existing, ...updates, updatedAt: new Date().toISOString() });
  }
  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() } as OrderRecord;
  const collections = Array.from(new Set(tradeCollectionsForStatus(merged.status ?? existing?.status ?? "OPEN")));

  for (const collectionName of collections) {
    try {
      const orderDocRef = doc(db, collectionName, orderId);
      // merge-write rather than updateDoc: the exited collections have no document yet
      // when an order first exits, and updateDoc would fail on a missing document.
      await setDoc(orderDocRef, { ...merged, updatedAt: new Date().toISOString() }, { merge: true });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "permission-denied") {
        console.warn(
          `Firestore rules: Access denied. Update firestore.rules or enable read/write in Firebase Console for /${collectionName}/{orderId}.`
        );
      } else {
        console.warn(`Failed to update order in Firestore collection ${collectionName}:`, err);
      }
    }
  }
  if (!isLiveStatus(merged.status ?? existing?.status)) await removeLiveCopies(orderId);
}

export async function getActiveOrdersFromFirestore(): Promise<OrderRecord[]> {
  const collections = [ORDERS_COLLECTION, ...LIVE_TRADE_COLLECTIONS];
  const mapped = new Map<string, OrderRecord>();

  const [collectionResults, closedResults] = await Promise.all([
    Promise.all(collections.map((collectionName) => readCollectionOrders(collectionName, ["OPEN", "FILLED"], 100))),
    Promise.all([
      readCollectionOrders(ORDERS_COLLECTION, ["EXITED", "CANCELLED", "SIMULATED"], 500),
      ...EXITED_TRADE_COLLECTIONS.map((collectionName) => readCollectionOrders(collectionName, [], 500)),
    ]),
  ]);
  // The orders collection and the exited collections are authoritative: an order recorded
  // there as closed is never active, even if a stale OPEN copy survives in a live collection.
  const closedIds = new Set(closedResults.flat().map((order) => order.id));
  const staleIds = new Set<string>();
  for (const docs of collectionResults) {
    for (const order of docs) {
      if (closedIds.has(order.id)) { staleIds.add(order.id); continue; }
      mapped.set(order.id, { ...order, status: String(order.status ?? "OPEN") as OrderRecord["status"] });
      localOrderStore.set(order.id, order);
    }
  }
  for (const id of closedIds) {
    const cached = localOrderStore.get(id);
    if (cached && isLiveStatus(cached.status)) localOrderStore.delete(id);
  }
  // Self-heal: remove stale live copies left behind by earlier versions of this module.
  if (staleIds.size) await Promise.all(Array.from(staleIds, (id) => removeLiveCopies(id)));

  for (const order of localOrderStore.values()) {
    if (["OPEN", "FILLED"].includes(String(order.status ?? "").toUpperCase())) {
      mapped.set(order.id, order);
    }
  }

  const uniqueActive = new Map<string, OrderRecord>();
  for (const order of mapped.values()) {
    const key = normalizeTradeSymbol(order.symbol);
    const existing = uniqueActive.get(key);
    if (!existing || new Date(order.updatedAt ?? order.createdAt).getTime() >= new Date(existing.updatedAt ?? existing.createdAt).getTime()) {
      uniqueActive.set(key, order);
    }
  }

  return Array.from(uniqueActive.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function getAllOrdersFromFirestore(maxResults = 100): Promise<OrderRecord[]> {
  const all = new Map<string, OrderRecord>(localOrderStore);
  const collections = Array.from(new Set([ORDERS_COLLECTION, ...LIVE_TRADE_COLLECTIONS, ...EXITED_TRADE_COLLECTIONS]));

  const collectionResults = await Promise.all(
    collections.map((collectionName) => readCollectionOrders(collectionName, [], maxResults))
  );
  for (const docs of collectionResults) {
    for (const order of docs) {
      all.set(order.id, order);
      localOrderStore.set(order.id, order);
    }
  }

  return Array.from(all.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
