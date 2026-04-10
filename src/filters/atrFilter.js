export function atrFilter(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  const atr =
    trs.slice(-period).reduce((a, b) => a + b, 0) / period;

  return {
    value: atr,
    isVolatile: atr > 0 // you can set threshold later
  };
}