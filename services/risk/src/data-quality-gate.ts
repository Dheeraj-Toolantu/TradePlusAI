import type { Freshness } from "../../../packages/domain-contracts/src/primitives";

export function canEnterWithData(freshness: Freshness): boolean { return freshness === "FRESH"; }