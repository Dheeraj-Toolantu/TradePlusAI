import type { IndexSentiment, IndexSentimentReading, TelegramStats } from "./index-sentiment";
import type { TelegramLive } from "./telegram-live";

const EMPTY: TelegramStats = { posts: 0, buy_calls: 0, sell_calls: 0, hype_posts: 0, channels: 0, views: 0 };

function mergeIndex(index: IndexSentimentReading, live: TelegramLive): IndexSentimentReading {
  const constituents = index.constituents.map((stock) => {
    const stats = live.stocks[stock.symbol];
    const telegram: TelegramStats = stats ? { posts: stats.posts, buy_calls: stats.buy_calls, sell_calls: stats.sell_calls, hype_posts: stats.hype_posts, channels: stats.channels, views: stats.views } : EMPTY;
    return { ...stock, retail: { ...stock.retail, telegram } };
  });
  const sum = (key: keyof TelegramStats) => constituents.reduce((total, stock) => total + stock.retail.telegram[key], 0);
  const tipped = constituents
    .filter((stock) => stock.retail.telegram.buy_calls + stock.retail.telegram.sell_calls > 0)
    .sort((a, b) => (b.retail.telegram.buy_calls + b.retail.telegram.sell_calls) - (a.retail.telegram.buy_calls + a.retail.telegram.sell_calls))
    .slice(0, 6)
    .map((stock) => ({ symbol: stock.symbol, buy_calls: stock.retail.telegram.buy_calls, sell_calls: stock.retail.telegram.sell_calls, hype_posts: stock.retail.telegram.hype_posts }));
  return { ...index, constituents, retail: { ...index.retail, telegram: { posts: sum("posts"), buy_calls: sum("buy_calls"), sell_calls: sum("sell_calls"), hype_posts: sum("hype_posts"), most_tipped: tipped } } };
}

/**
 * Overlay the minute-by-minute Telegram scan on the last full sentiment scan: per-stock Telegram
 * calls, each index's Telegram summary and the option-call consensus. Scores are left as the full
 * scan computed them (they move every 10 minutes, Telegram counts every minute).
 */
export function mergeTelegram(data: IndexSentiment | null, live: TelegramLive | null): IndexSentiment | null {
  if (!data || !live) return data;
  return { ...data, indices: data.indices.map((index) => mergeIndex(index, live)), telegram_options: live.options };
}
