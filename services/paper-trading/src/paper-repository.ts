export type PaperOrder = { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; status: "OPEN" | "FILLED" | "CANCELLED" };
export type PaperAccount = { id: string; capital: number; balance: number; realizedPnl: number; orders: PaperOrder[] };

export class PaperRepository {
  private readonly accounts = new Map<string, PaperAccount>();
  create(id: string, capital: number) { const account = { id, capital, balance: capital, realizedPnl: 0, orders: [] }; this.accounts.set(id, account); return account; }
  get(id: string) { return this.accounts.get(id); }
}