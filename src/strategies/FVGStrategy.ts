import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';

export interface FVG {
    top: number;
    bottom: number;
    direction: "bullish" | "bearish";
    formedAt: number; // candle index
    filled: boolean;
    startTime: number;
    endTime: number;
    filledAt?: number;
}

export class FVGStrategy implements Strategy {
    id = "fvg-imbalance";
    name = "Fair Value Gap Strategy";
    description = "Institutional imbalance detection with consequent encroachment entry logic.";

    run(candles: Candle[], params: Record<string, any>): { 
        trades: Trade[], 
        finalBalance: number, 
        activeTrade?: Trade | null,
        indicators?: Record<string, any>
    } {
        const trades: Trade[] = [];
        let balance = params.capital || 250;
        const rr = params.riskRewardRatio || 3.5;
        const riskAmount = params.riskAmount || 5; // Fixed risk amount per trade
        const fvgExpiryCandles = 50; // Max candles to wait for return

        const allFVGs: FVG[] = []; // Archive for indicators
        let activeFVGs: FVG[] = []; // Hot list for loop efficiency
        let activeTrade: Trade | null = null;
        let lastExitIndex = -1;

        for (let i = 2; i < candles.length; i++) {
            const c1 = candles[i - 2]!;
            const c2 = candles[i - 1]!;
            const c3 = candles[i]!;

            // 1. Detect New FVG
            if (c3.low > c1.high) {
                const gapSize = c3.low - c1.high;
                if (gapSize > (c3.close * 0.0002)) {
                    const fvg: FVG = {
                        top: c3.low,
                        bottom: c1.high,
                        direction: "bullish",
                        formedAt: i,
                        filled: false,
                        startTime: c1.time,
                        endTime: c3.time
                    };
                    allFVGs.push(fvg);
                    activeFVGs.push(fvg);
                }
            }
            else if (c3.high < c1.low) {
                const gapSize = c1.low - c3.high;
                if (gapSize > (c3.close * 0.0002)) {
                    const fvg: FVG = {
                        top: c1.low,
                        bottom: c3.high,
                        direction: "bearish",
                        formedAt: i,
                        filled: false,
                        startTime: c1.time,
                        endTime: c3.time
                    };
                    allFVGs.push(fvg);
                    activeFVGs.push(fvg);
                }
            }

            // 2. Manage Active Trade
            if (activeTrade) {
                const curr = candles[i]!;
                const isBuy = activeTrade.direction === "buy";

                const hitSL = isBuy ? curr.low <= (activeTrade.sl || 0) : curr.high >= (activeTrade.sl || Infinity);
                const hitTP = isBuy ? curr.high >= (activeTrade.tp || Infinity) : curr.low <= (activeTrade.tp || 0);

                if (hitSL || hitTP) {
                    activeTrade.status = "closed";
                    activeTrade.exitTime = new Date(curr.time).toISOString();
                    
                    if (hitSL) {
                        activeTrade.exitPrice = isBuy ? Math.min(curr.open, activeTrade.sl || 0) : Math.max(curr.open, activeTrade.sl || Infinity);
                        activeTrade.exitReason = "Stop Loss";
                    } else if (hitTP) {
                        activeTrade.exitPrice = activeTrade.tp || curr.close;
                        activeTrade.exitReason = "Take Profit";
                    }
                    
                    const units = activeTrade.units || 0;
                    if (isBuy) {
                        activeTrade.profit = (activeTrade.exitPrice! - activeTrade.entryPrice) * units;
                    } else {
                        activeTrade.profit = (activeTrade.entryPrice - activeTrade.exitPrice!) * units;
                    }

                    activeTrade.pnlPercent = (activeTrade.profit / balance) * 100;
                    balance += activeTrade.profit;
                    
                    trades.push({ ...activeTrade });
                    activeTrade = null;
                    lastExitIndex = i;
                }
            }

            // 3. Look for Entry in unfilled active FVGs
            if (activeTrade || i === lastExitIndex) continue;
            
            const curr = candles[i]!;

            for (let j = 0; j < activeFVGs.length; j++) {
                const fvg = activeFVGs[j];
                if (!fvg) continue;
                
                if (i <= fvg.formedAt) continue;

                if (i - fvg.formedAt > fvgExpiryCandles) {
                    fvg.filled = true;
                    fvg.filledAt = curr.time;
                    activeFVGs.splice(j, 1);
                    j--;
                    continue;
                }

                const midpoint = (fvg.top + fvg.bottom) / 2;

                if (fvg.direction === "bullish") {
                    if (curr.low < fvg.bottom) {
                        fvg.filled = true;
                        fvg.filledAt = curr.time;
                        activeFVGs.splice(j, 1);
                        j--; 
                        continue;
                    }

                    if (curr.low <= midpoint && curr.high >= midpoint) {
                        const gapSize = fvg.top - fvg.bottom; 
                        const buffer = gapSize * 0.05;
                        const sl = fvg.bottom - buffer; 
                        const riskPerUnit = Math.abs(midpoint - sl);
                        
                        if (riskPerUnit < (midpoint * 0.0001)) {
                            fvg.filled = true;
                            fvg.filledAt = curr.time;
                            activeFVGs.splice(j, 1);
                            j--;
                            continue;
                        }
                        
                        const units = riskAmount / riskPerUnit;
                        const tp = midpoint + (riskPerUnit * rr);
                        
                        activeTrade = {
                            entryTime: new Date(curr.time).toISOString(),
                            direction: "buy",
                            entryPrice: midpoint,
                            units: units,
                            sl: sl,
                            tp: tp,
                            status: "open",
                            profit: 0
                        };
                        fvg.filled = true;
                        fvg.filledAt = curr.time;
                        activeFVGs.splice(j, 1);
                        break;
                    }
                } else {
                    if (curr.high > fvg.top) {
                        fvg.filled = true;
                        fvg.filledAt = curr.time;
                        activeFVGs.splice(j, 1);
                        j--;
                        continue;
                    }

                    if (curr.high >= midpoint && curr.low <= midpoint) {
                        const gapSize = fvg.top - fvg.bottom; 
                        const buffer = gapSize * 0.05;
                        const sl = fvg.top + buffer; 
                        const riskPerUnit = Math.abs(sl - midpoint);
                        
                        if (riskPerUnit < (midpoint * 0.0001)) {
                            fvg.filled = true;
                            fvg.filledAt = curr.time;
                            activeFVGs.splice(j, 1);
                            j--;
                            continue;
                        }

                        const units = riskAmount / riskPerUnit;
                        const tp = midpoint - (riskPerUnit * rr);

                        activeTrade = {
                            entryTime: new Date(curr.time).toISOString(),
                            direction: "sell",
                            entryPrice: midpoint,
                            units: units,
                            sl: sl,
                            tp: tp,
                            status: "open",
                            profit: 0
                        };
                        fvg.filled = true;
                        fvg.filledAt = curr.time;
                        activeFVGs.splice(j, 1);
                        break;
                    }
                }
            }
        }

        return {
            trades,
            finalBalance: balance,
            indicators: {
                totalFVGsDetected: allFVGs.length,
                fvgs: allFVGs.map(f => ({
                    ...f,
                    formationStartTime: f.startTime,
                    formationEndTime: candles[Math.min(f.formedAt, candles.length - 1)]?.time || f.endTime,
                    fillTime: f.filledAt || (candles.length > 0 ? candles[candles.length - 1]!.time : f.endTime)
                }))
            }
        };
    }
}
