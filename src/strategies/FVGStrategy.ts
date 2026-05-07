import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';
import { calculateEMA, calculateRSI } from './StrategyUtils.js';

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
        const rr = params.riskRewardRatio || 3.8;
        const riskAmount = params.riskAmount || 5; // Fixed risk amount per trade
        const fvgExpiryCandles = 30; // Max candles to wait for return (Reduced for Freshness)
        const rangeLookback = 50; // Lookback for Premium/Discount zone

        // --- MOMENTUM & TREND PRE-CALCULATION ---
        const closes = candles.map(c => c.close);
        const ema50 = calculateEMA(closes, 50);
        const ema200 = calculateEMA(closes, 200);
        const rsiValues = calculateRSI(closes, 14);
        // ----------------------------------------

        const allFVGs: FVG[] = []; // Archive for indicators
        let activeFVGs: FVG[] = []; // Hot list for loop efficiency
        let activeTrade: Trade | null = null;
        let lastExitIndex = -1;

        for (let i = 2; i < candles.length; i++) {
            const c1 = candles[i - 2]!;
            const c2 = candles[i - 1]!;
            const c3 = candles[i]!;

            // 1. Detect New FVG
            const c2Range = c2.high - c2.low;
            const c2Body = Math.abs(c2.open - c2.close);
            const c2BodyRatio = c2Range > 0 ? c2Body / c2Range : 0;

            if (c3.low > c1.high) {
                const gapSize = c3.low - c1.high;
                // Rule: Strong Body (>= 20%) + Minimum Gap Size
                if (gapSize > (c3.close * 0.0002) && c2BodyRatio >= 0.2) {
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
                // Rule: Strong Body (>= 60%) + Minimum Gap Size
                if (gapSize > (c3.close * 0.0002) && c2BodyRatio >= 0.6) {
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
                    const feeRate = 0.0005; // 0.05% per side (Maker/Taker average)
                    
                    let grossProfit = 0;
                    if (isBuy) {
                        grossProfit = (activeTrade.exitPrice! - activeTrade.entryPrice) * units;
                    } else {
                        grossProfit = (activeTrade.entryPrice - activeTrade.exitPrice!) * units;
                    }

                    // Net PnL = Gross Profit - Entry Fee - Exit Fee
                    const entryFee = activeTrade.entryPrice * units * feeRate;
                    const exitFee = activeTrade.exitPrice! * units * feeRate;
                    activeTrade.profit = grossProfit - entryFee - exitFee;

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
            const e50 = ema50[i] || 0;
            const currentRSI = rsiValues[i] || 50;

            // --- PREMIUM / DISCOUNT ZONE CALCULATION ---
            const startRange = Math.max(0, i - rangeLookback);
            const window = candles.slice(startRange, i + 1);
            const rangeHigh = Math.max(...window.map(can => can.high));
            const rangeLow = Math.min(...window.map(can => can.low));
            const equilibrium = (rangeHigh + rangeLow) / 2;
            // --------------------------------------------

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
                    // --- INSTITUTIONAL FILTERS ---
                    // 1. Trend: Above EMA50
                    if (curr.close <= e50) continue;
                    // 2. Momentum: RSI between 45 and 75
                    if (currentRSI <= 45 || currentRSI >= 75) continue;
                    // 3. PD Zone: Only buy in DISCOUNT (< 50% of recent range)
                    if (curr.close >= equilibrium) continue;
                    // -----------------------------

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
                            profit: 0,
                            indicators: { fvgTop: fvg.top, fvgBottom: fvg.bottom }
                        };
                        fvg.filled = true;
                        fvg.filledAt = curr.time;
                        activeFVGs.splice(j, 1);
                        break;
                    }
                } else {
                    // --- INSTITUTIONAL FILTERS ---
                    // 1. Trend: Below EMA50
                    if (curr.close >= e50) continue;
                    // 2. Momentum: RSI between 25 and 55
                    if (currentRSI >= 55 || currentRSI <= 25) continue;
                    // 3. PD Zone: Only sell in PREMIUM (> 50% of recent range)
                    if (curr.close <= equilibrium) continue;
                    // -----------------------------

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
                            profit: 0,
                            indicators: { fvgTop: fvg.top, fvgBottom: fvg.bottom }
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
