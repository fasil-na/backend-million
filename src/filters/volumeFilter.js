export function volumeFilter(volumeData, multiplier = 1.2) {
  const avg =
    volumeData.reduce((a, b) => a + b, 0) / volumeData.length;

  const current = volumeData.at(-1);

  return {
    isHigh: current > avg * multiplier,
    current,
    average: avg
  };
}