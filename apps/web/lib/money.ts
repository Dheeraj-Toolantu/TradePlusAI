export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";

  const asNumber = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-+]/g, ""));
  if (!Number.isFinite(asNumber)) return "—";

  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(asNumber);
}