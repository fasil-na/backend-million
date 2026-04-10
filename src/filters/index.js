import { emaFilter } from "./emaFilter.js";
import { rsiFilter } from "./rsiFilter.js";
import { volumeFilter } from "./volumeFilter.js";
import { atrFilter } from "./atrFilter.js";

export function applyFilters(marketData, config) {
  const close = marketData.close;
  const volume = marketData.volume;
  const high = marketData.high;
  const low = marketData.low;

  const ema = emaFilter(close, config.emaShort, config.emaLong);
  const rsi = rsiFilter(close, config.rsiPeriod);
  const vol = volumeFilter(volume, config.volumeMultiplier);
  const atr = atrFilter(high, low, close, config.atrPeriod);

  return {
    ema,
    rsi,
    vol,
    atr,
    finalSignal:
      ema.isBullish &&
      rsi.value > 50 &&
      vol.isHigh &&
      atr.isVolatile
  };
}