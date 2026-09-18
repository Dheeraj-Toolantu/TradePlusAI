import { describe, expect, it } from "vitest";
import { GrowwInstrumentCatalog, parseGrowwInstrumentsCsv } from "../../adapters/groww/src/groww-instruments";

const csv = [
  "exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,segment,series,isin,underlying_symbol,underlying_exchange_token,expiry_date,strike_price,lot_size,tick_size,freeze_quantity,is_reserved,buy_allowed,sell_allowed",
  "NSE,2885,RELIANCE,NSE-RELIANCE,Reliance Industries,EQ,CASH,EQ,INE002A01018,,,,,1,0.05,500,0,1,1",
].join("\n");

describe("Groww instrument catalog", () => {
  it("parses documented CSV columns and normalizes values", () => {
    const instrument = parseGrowwInstrumentsCsv(csv)[0];
    expect(instrument).toMatchObject({ exchange: "NSE", exchangeToken: "2885", tradingSymbol: "RELIANCE", growwSymbol: "NSE-RELIANCE", segment: "CASH", lotSize: 1, tickSize: 0.05, buyAllowed: true });
  });

  it("supports Groww's documented lookup keys", () => {
    const catalog = new GrowwInstrumentCatalog(parseGrowwInstrumentsCsv(csv));
    expect(catalog.getByGrowwSymbol("NSE-RELIANCE")?.tradingSymbol).toBe("RELIANCE");
    expect(catalog.getByTradingSymbol("NSE", "RELIANCE")?.exchangeToken).toBe("2885");
    expect(catalog.getByExchangeToken("2885")?.growwSymbol).toBe("NSE-RELIANCE");
  });
});