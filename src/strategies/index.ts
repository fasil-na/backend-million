import type { Candle, Trade } from '../types/index.js';

export interface Strategy {
    id: string;
    name: string;
    description: string;
    run(candles: Candle[], params: Record<string, any>, subCandles?: Candle[]): { trades: Trade[], finalBalance: number, activeTrade?: Trade | null } | { matched: boolean, trade?: Trade };
}

import { OpeningBreakoutStrategy } from './OpeningBreakoutStrategy.js';
import { EmaCrossoverStrategy } from './EmaCrossoverStrategy.js';
import { GoldOpeningBreakout } from './OBGoldStrategy.js';

export const strategies: Record<string, Strategy> = {
    'opening-breakout': new OpeningBreakoutStrategy(),
    'ema-crossover': new EmaCrossoverStrategy(),
    'gold-opening-breakout': new GoldOpeningBreakout(),
};
