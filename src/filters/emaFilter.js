export function emaFilter(data, shortPeriod, longPeriod) {
  const shortEMA = calculateEMA(data, shortPeriod);
  const longEMA = calculateEMA(data, longPeriod);

  const lastShort = shortEMA.at(-1);
  const lastLong = longEMA.at(-1);

  return {
    isBullish: lastShort > lastLong,
    isBearish: lastShort < lastLong,
    shortEMA: lastShort,
    longEMA: lastLong
  };
}

// simple EMA calculator
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = [data[0]];

  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }

  return ema;
}