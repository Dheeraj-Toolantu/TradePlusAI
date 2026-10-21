export type CommodityId = "CRUDEOIL" | "NATURALGAS" | "GOLD" | "SILVER" | "COPPER";
export type CommodityReading = {
  id: CommodityId; name: string; symbol: string; unit: string;
  score: number | null; label: string;
  price: number | null; change_pct: number | null; five_day_pct: number | null; vs_20dma_pct: number | null;
  lenses: { price: number | null; trend: number | null; news: number | null };
  india_impact: number | null; india_label: string; why: string;
  headlines: Array<{ title: string; link: string; source: string; age_hours: number; score: number }>;
};
export type CommoditySentiment = { generated_at: string; commodities: CommodityReading[]; notes: string[]; errors: string[]; method: string };
