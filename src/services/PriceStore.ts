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

  // 🎯 ASYNC FALLBACK: Instantly pull the true price from exchange if missing
  static async getOrFetch(pair: string): Promise<number> {
    const cached = this.get(pair);
    if (cached !== undefined && cached > 0) return cached;
    
    try {
        const normalizedPair = formatPair(pair);
        console.log(`[PriceStore] No local cache for ${normalizedPair}. Triggering Fallback REST fetch...`);
        const { CoinDCXApiService } = await import('./CoinDCXApiService.js');
        const now = Math.floor(Date.now() / 1000);
        
        const candleRes = await CoinDCXApiService.getCandlesticks({
            pair: normalizedPair,
            resolution: '1',
            from: now - 300, 
            to: now
        });
        
        if (candleRes && candleRes.s === 'ok' && Array.isArray(candleRes.data) && candleRes.data.length > 0) {
            const latestCandle = candleRes.data.reduce((latest: any, current: any) => current.time > latest.time ? current : latest, candleRes.data[0]);
            if (latestCandle && latestCandle.close) {
                const price = Number(latestCandle.close);
                this.update(normalizedPair, price);
                return price;
            }
        }
    } catch (e: any) {}
    
    return 0; // Return exactly 0 so the controller fails gracefully instead of crashing
  }
}
