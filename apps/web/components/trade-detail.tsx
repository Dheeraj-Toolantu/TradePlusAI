export function TradeDetail({ symbol, entry, stop, target }: { symbol: string; entry: number; stop: number; target: number }) {
  return <section aria-label="Trade detail"><h2>{symbol}</h2><p>Entry {entry} · Stop {stop} · Target {target}</p></section>;
}