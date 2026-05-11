import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { calculateEMA, calculateRSI } from './StrategyUtils.js';
import { TradeService } from '../services/TradeService.js';

dayjs.extend(utc);
dayjs.extend(timezone);
 
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
 
    run(candles: Candle[], params: Record<string, any>): any {
        if (params.type === 'live') {
            return this.checkSignal(candles, params);
        }

        const trades: Trade[] = [];
        let balance = params.capital || 250;
        const rr = params.riskRewardRatio || 3.9; // Updated to 1:3.9 RR
        const riskAmount = params.riskAmount || 5; // Fixed $5 risk per trade
        const fvgExpiryCandles = 100; // Max candles to wait for return (Reduced for Freshness)
        const rangeLookback = 100; // Lookback for Premium/Discount zone

        const cleanPair = (params.pair || 'B-BTC_USDT').replace('B-', '').toLowerCase();
        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
 
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
            //******0.02 */
                if (gapSize > (c3.close * 0.0002) && c2BodyRatio >= 0.01) {
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
                if (gapSize > (c3.close * 0.0002) && c2BodyRatio >= 0.01) {
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
                    activeTrade.exitTime = dayjs(curr.time).tz('Asia/Kolkata').format();
                    
                    if (hitSL) {
                        // Fixed $5 concept: exit exactly at SL price
                        activeTrade.exitPrice = activeTrade.sl || (isBuy ? curr.low : curr.high);
                        activeTrade.exitReason = "Stop Loss";
                    } else if (hitTP) {
                        // Fixed RR concept: exit exactly at TP price
                        activeTrade.exitPrice = activeTrade.tp || (isBuy ? curr.high : curr.low);
                        activeTrade.exitReason = "Take Profit";
                    }
                    
                    const units = activeTrade.units || 0;
                    const feeRate = 0; // Fees set to 0 for the "Fixed $5" concept
                    
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
                    // --- INSTITUTIONAL FILTERS (DISABLED FOR TESTING) ---
                    // 1. Trend: Above EMA50
                    // if (curr.close <= e50) continue;
                    // 2. Momentum: RSI between 45 and 75
                    // if (currentRSI <= 45 || currentRSI >= 75) continue;
                    // 3. PD Zone: Only buy in DISCOUNT (< 50% of recent range)
                    // if (curr.close >= equilibrium) continue;
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
                        const riskPerUnit = Math.abs(midpoint - (fvg.bottom - buffer));
                        
                        if (riskPerUnit < (midpoint * 0.00001)) {
                            fvg.filled = true;
                            fvg.filledAt = curr.time;
                            activeFVGs.splice(j, 1);
                            j--;
                            continue;
                        }
                        
                        const unitsPrecision = staticData.qtyStep.toString().split('.')[1]?.length || 0;
                        let units = riskAmount / riskPerUnit;
                        units = Number(units.toFixed(unitsPrecision));
                        
                        // Ensure units >= qtyStep
                        if (units < staticData.qtyStep) units = staticData.qtyStep;

                        const tp = Number((midpoint + (riskPerUnit * rr)).toFixed(pricePrecision));
                        const sl = Number((midpoint - riskPerUnit).toFixed(pricePrecision));
                        
                        activeTrade = {
                            entryTime: dayjs(curr.time).tz('Asia/Kolkata').format(),
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
                    // --- INSTITUTIONAL FILTERS (DISABLED FOR TESTING) ---
                    // 1. Trend: Below EMA50
                    // if (curr.close >= e50) continue;
                    // 2. Momentum: RSI between 25 and 55
                    // if (currentRSI >= 55 || currentRSI <= 25) continue;
                    // 3. PD Zone: Only sell in PREMIUM (> 50% of recent range)
                    // if (curr.close <= equilibrium) continue;
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
                        const riskPerUnit = Math.abs((fvg.top + buffer) - midpoint);
                        
                        if (riskPerUnit < (midpoint * 0.00001)) {
                            fvg.filled = true;
                            fvg.filledAt = curr.time;
                            activeFVGs.splice(j, 1);
                            j--;
                            continue;
                        }
 
                        const unitsPrecision = staticData.qtyStep.toString().split('.')[1]?.length || 0;
                        let units = riskAmount / riskPerUnit;
                        units = Number(units.toFixed(unitsPrecision));

                        // Ensure units >= qtyStep
                        if (units < staticData.qtyStep) units = staticData.qtyStep;

                        const tp = Number((midpoint - (riskPerUnit * rr)).toFixed(pricePrecision));
                        const sl = Number((midpoint + riskPerUnit).toFixed(pricePrecision));
 
                        activeTrade = {
                            entryTime: dayjs(curr.time).tz('Asia/Kolkata').format(),
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
            trade: activeTrade,
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

    private checkSignal(candles: Candle[], params: Record<string, any>): { matched: boolean, trade?: Trade } {
        if (candles.length < 5) return { matched: false };
        
        // We only care about the last 100 candles to detect relevant FVGs
        const lookback = Math.min(candles.length, 100);
        const relevantCandles = candles.slice(-lookback);
        
        // Re-run the FVG detection on the subset
        const result = this.run(relevantCandles, { ...params, type: 'backtest' });
        
        return {
            matched: !!result.trade,
            trade: result.trade
        };
    }
}