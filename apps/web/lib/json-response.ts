import { gzipSync } from "node:zlib";

// Route handlers stream JSON uncompressed; the sentiment payload is ~6x smaller gzipped. Cache the
// compressed body per version so repeated reads of the same scan don't re-compress.
const compressed = new Map<string, Buffer>();
const MAX_CACHED = 8;

/** JSON response with a weak ETag (304 when unchanged) and gzip when the client accepts it. */
export function versionedJson(request: Request | undefined, body: unknown, version: string, init: { status?: number; maxAge?: number } = {}): Response {
  const etag = `W/"${version}"`;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", etag, "cache-control": `private, max-age=${init.maxAge ?? 0}, must-revalidate`, vary: "accept-encoding" };
  if (request?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const json = JSON.stringify(body);
  if (!/\bgzip\b/.test(request?.headers.get("accept-encoding") ?? "") || json.length < 2048) return new Response(json, { status: init.status ?? 200, headers });
  let buffer = compressed.get(version);
  if (!buffer) {
    buffer = gzipSync(json);
    compressed.set(version, buffer);
    if (compressed.size > MAX_CACHED) compressed.delete(compressed.keys().next().value as string);
  }
  return new Response(new Uint8Array(buffer), { status: init.status ?? 200, headers: { ...headers, "content-encoding": "gzip" } });
}
