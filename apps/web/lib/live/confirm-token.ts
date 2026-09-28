import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// A preview returns a short-lived, single-use token that binds the exact ticket the user saw
// (contract, side, quantity, limit price, stop, target). Confirm must present it unchanged:
// the browser cannot alter quantity or price between the dialog and the broker call.
export type LiveTicket = {
  symbol: string;
  exchange: "NSE" | "BSE";
  side: "BUY";
  lots: number;
  lotSize: number;
  quantity: number;
  limitPrice: number;
  stopLoss: number;
  target: number;
  tickSize: number;
  underlying: string;
  expiry: string;
  optionType: "CE" | "PE";
  strike: number;
  source: string;
};

type Envelope = { nonce: string; exp: number; ticket: LiveTicket };
const usedGlobal = globalThis as typeof globalThis & { __tradepulseUsedNonces?: Map<string, number> };
const used = (usedGlobal.__tradepulseUsedNonces ??= new Map());

const sign = (payload: string, secret: Buffer) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueToken(ticket: LiveTicket, secret: Buffer, ttlSeconds: number, nowMs = Date.now()): { token: string; expiresAt: string } {
  const envelope: Envelope = { nonce: randomBytes(12).toString("base64url"), exp: nowMs + ttlSeconds * 1000, ticket };
  const payload = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt: new Date(envelope.exp).toISOString() };
}

export type TokenResult = { ok: true; ticket: LiveTicket; nonce: string } | { ok: false; error: string };

/** Verifies signature and expiry. Does NOT consume the nonce; call consumeNonce right before placing. */
export function verifyToken(token: unknown, secret: Buffer, nowMs = Date.now()): TokenResult {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, error: "Missing confirmation token" };
  const [payload, signature] = token.split(".");
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, error: "Confirmation token signature is invalid" };
  let envelope: Envelope;
  try { envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Envelope; } catch { return { ok: false, error: "Confirmation token is malformed" }; }
  if (!(envelope.exp > nowMs)) return { ok: false, error: "Confirmation expired; preview the order again" };
  if (used.has(envelope.nonce)) return { ok: false, error: "This confirmation was already used" };
  return { ok: true, ticket: envelope.ticket, nonce: envelope.nonce };
}

export function consumeNonce(nonce: string, nowMs = Date.now()): boolean {
  for (const [key, at] of used) if (nowMs - at > 10 * 60_000) used.delete(key);
  if (used.has(nonce)) return false;
  used.set(nonce, nowMs);
  return true;
}
