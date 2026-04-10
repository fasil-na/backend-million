export function rsiFilter(data, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const rs = gains / losses;
  const rsi = 100 - (100 / (1 + rs));

  return {
    value: rsi,
    isOverbought: rsi > 70,
    isOversold: rsi < 30
  };
}