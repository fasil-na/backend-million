import { formatPair } from '../strategies/StrategyUtils.js';

export class PriceStore {
  private static prices = new Map<string, number>();

  static update(pair: string, price: number) {
    if (!pair || price === undefined) return;
    const normalizedPair = formatPair(pair);
    this.prices.set(normalizedPair, price);
  }

  static get(pair: string): number | undefined {
    if (!pair) return undefined;
    const normalizedPair = formatPair(pair);
    return this.prices.get(normalizedPair);
  }
}
