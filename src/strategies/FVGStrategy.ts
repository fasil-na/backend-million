import type { Candle, Trade } from '../types/index.js';

import type { Strategy } from './index.js';

import dayjs from 'dayjs';

import utc from 'dayjs/plugin/utc.js';

import timezone from 'dayjs/plugin/timezone.js';

import { calculateEMA, calculateRSI } from './StrategyUtils.js';

import { TradeService } from '../services/TradeService.js';

dayjs.extend(utc);

dayjs.extend(timezone);

const DEFAULT_RISK_REWARD_RATIO = 3.5;
export const FVG_EXPIRY_CANDLES = 50;
const RANGE_LOOKBACK = 10;
const MIN_GAP_SIZE_RATIO = 0.00005;
const MIN_C2_BODY_RATIO = 0.001;
const EMA_SHORT_PERIOD = 10;
const EMA_LONG_PERIOD = 24;
const RSI_PERIOD = 14;
const RSI_BULLISH_MIN = 15;
const RSI_BULLISH_MAX = 75;
const MIN_RISK_PER_UNIT =30;
const BEARISH_SL_BUFFER_RATIO = 0.001;
const RSI_BEARISH_MIN = 15;
const RSI_BEARISH_MAX = 75;
const LIVE_SIGNAL_LOOKBACK = 50;


const INITIAL_BALANCE = 10000;
const DEFAULT_MIN_NOTIONAL = 6;
const DEFAULT_PAIR_KEY = 'B-BTC_USDT';
const TRADE_TIMEZONE = 'Asia/Kolkata';
 const DEFAULT_RESOLUTION = "15";
const MAKER_FEE_RATE = 0.0003;
const TAKER_FEE_RATE = 0.0006;
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

    run(candles: Candle[], params: Record<string, any>, subCandles: Candle[] = []): any {

        if (params.type === 'live') {

            return this.checkSignal(candles, params);

        }

        const trades: Trade[] = [];

        let balance = INITIAL_BALANCE;

        const rr = params.riskRewardRatio || DEFAULT_RISK_REWARD_RATIO;

        const riskAmount = params.riskAmount; // Derived strictly from configuration

        const fvgExpiryCandles = FVG_EXPIRY_CANDLES;

        const rangeLookback = RANGE_LOOKBACK;

        const simulationStart = params.simulationStartUnix ? params.simulationStartUnix * 1000 : 0;

        const cleanPair = (params.pair || DEFAULT_PAIR_KEY).replace('B-', '').toLowerCase();

        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS[DEFAULT_PAIR_KEY];

        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;

        // --- MOMENTUM & TREND PRE-CALCULATION ---

        const closes = candles.map(c => c.close);

        const ema50 = calculateEMA(closes, EMA_SHORT_PERIOD);

        const ema200 = calculateEMA(closes, EMA_LONG_PERIOD);

        const rsiValues = calculateRSI(closes, RSI_PERIOD);

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

                if (gapSize > (c3.close * MIN_GAP_SIZE_RATIO) && c2BodyRatio >= MIN_C2_BODY_RATIO) {

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

                if (gapSize > (c3.close * MIN_GAP_SIZE_RATIO) && c2BodyRatio >= MIN_C2_BODY_RATIO) {

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
console.log(activeTrade,'activeTrade----')
            if (activeTrade) {

                const curr = candles[i]!;

                const isBuy = activeTrade.direction === "buy";

                const hitSL = isBuy ? curr.low <= (activeTrade.sl || 0) : curr.high >= (activeTrade.sl || Infinity);

                const hitTP = isBuy ? curr.high >= (activeTrade.tp || Infinity) : curr.low <= (activeTrade.tp || 0);

                if (hitSL || hitTP) {

                    activeTrade.status = "closed";

                    activeTrade.exitTime = dayjs(curr.time).tz(TRADE_TIMEZONE).format();

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

                    let grossProfit = 0;

                    if (isBuy) {

                        grossProfit = (activeTrade.exitPrice! - activeTrade.entryPrice) * units;

                    } else {

                        grossProfit = (activeTrade.entryPrice - activeTrade.exitPrice!) * units;

                    }

                    // Net PnL = Gross Profit - Entry Fee - Exit Fee
                    const isTakeProfit = activeTrade.exitReason === "Take Profit" || activeTrade.exitReason === "Take Profit (Sub)";
                    const exitFeeRate = isTakeProfit ? MAKER_FEE_RATE : TAKER_FEE_RATE;

                    const entryFee = activeTrade.entryPrice * units * MAKER_FEE_RATE;
                    const exitFee = activeTrade.exitPrice! * units * exitFeeRate;
                    console.log(grossProfit, 'grossProfit------')
                    console.log(entryFee, 'entryFee------')
                    console.log(exitFee, 'exitFee------')
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

                if (params.type === 'live_signal') {
                    if (i !== fvg.formedAt) continue;
                } else {
                    if (i <= fvg.formedAt) continue;
                }

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
                    
                    // Re-calculate the equilibrium EXACTLY as it was when the FVG formed
                    const fvgStartRange = Math.max(0, fvg.formedAt - rangeLookback);
                    const fvgWindow = candles.slice(fvgStartRange, fvg.formedAt + 1);
                    const fvgEquilibrium = (Math.max(...fvgWindow.map(c => c.high)) + Math.min(...fvgWindow.map(c => c.low))) / 2;

                    // 1. Trend: Evaluate EMA50 exactly at the time the FVG formed (when Limit Order is placed)
                    // if (candles[fvg.formedAt]!.close <= ema50[fvg.formedAt]!) continue;

                    // 2. Momentum: Evaluate RSI exactly at the time the FVG formed
                    const formedRSI = rsiValues[fvg.formedAt] || 50;
                    if (formedRSI <= RSI_BULLISH_MIN || formedRSI >= RSI_BULLISH_MAX) continue;

                    // 3. PD Zone: The entry price (midpoint) MUST be in the DISCOUNT zone relative to the range at formation
                    // if (midpoint >= fvgEquilibrium) continue;

                    // -----------------------------

                    if (curr.low < fvg.bottom) {

                        fvg.filled = true;

                        fvg.filledAt = curr.time;

                        activeFVGs.splice(j, 1);

                        j--;

                        continue;

                    }

                    const entryCondition = params.type === 'live_signal' ? true : (curr.low <= midpoint && curr.high >= midpoint);
                    if (entryCondition) {

                        // 🕒 Only enter trades AFTER simulationStart

                        if (curr.time < simulationStart) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const gapSize = fvg.top - fvg.bottom;

                        const buffer = 0;

                        const riskPerUnit = Math.abs(midpoint - (fvg.bottom - buffer));

                        if (riskPerUnit < MIN_RISK_PER_UNIT) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const unitsPrecision = staticData.qtyStep.toString().split('.')[1]?.length || 0;

                        let units = riskAmount / riskPerUnit;

                        units = Number(units.toFixed(unitsPrecision));

                        // Enforce minimum quantity based on STATIC_INSTRUMENTS (minNotional & qtyStep)

                        const minNotional = staticData.minNotional || DEFAULT_MIN_NOTIONAL;

                        const minQty = Math.ceil((minNotional / midpoint) / staticData.qtyStep) * staticData.qtyStep;

                        if (units < minQty || units <= 0) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const tp = Number((midpoint + (riskPerUnit * rr)).toFixed(pricePrecision));

                        const sl = Number((midpoint - riskPerUnit).toFixed(pricePrecision));

                        activeTrade = {

                            entryTime: dayjs(curr.time).tz(TRADE_TIMEZONE).format(),

                            direction: "buy",

                            entryPrice: midpoint,

                            units: units,

                            sl: sl,

                            tp: tp,

                            resolution: params.resolution || DEFAULT_RESOLUTION,

                            status: "open",

                            orderType: "limit_order",

                            profit: 0,

                            indicators: { fvgTop: fvg.top, fvgBottom: fvg.bottom }

                        };

                        // --- INTRA-CANDLE EXIT CHECK ---

                        // If we just entered, check if the rest of THIS candle (or sub-candles) hits SL/TP

                        const exitInfo = this.checkIntraCandleExit(activeTrade, curr, subCandles);

                        if (exitInfo) {

                            activeTrade.status = "closed";

                            activeTrade.exitPrice = exitInfo.price;

                            activeTrade.exitTime = exitInfo.time;

                            activeTrade.exitReason = exitInfo.reason;

                            const { profit, fee } = this.calculatePnL(activeTrade, activeTrade.exitPrice, balance);

                            activeTrade.profit = profit;

                            activeTrade.pnlPercent = (profit / balance) * 100;

                            balance += profit;

                            trades.push({ ...activeTrade });

                            activeTrade = null;

                            lastExitIndex = i;

                        }

                        fvg.filled = true;

                        fvg.filledAt = curr.time;

                        activeFVGs.splice(j, 1);

                        break;

                    }

                } else {

                    // --- INSTITUTIONAL FILTERS ---
                    
                    // Re-calculate the equilibrium EXACTLY as it was when the FVG formed
                    const fvgStartRange = Math.max(0, fvg.formedAt - rangeLookback);
                    const fvgWindow = candles.slice(fvgStartRange, fvg.formedAt + 1);
                    const fvgEquilibrium = (Math.max(...fvgWindow.map(c => c.high)) + Math.min(...fvgWindow.map(c => c.low))) / 2;

                    // 1. Trend: Evaluate EMA50 exactly at the time the FVG formed
                    // if (candles[fvg.formedAt]!.close >= ema50[fvg.formedAt]!) continue;

                    // 2. Momentum: Evaluate RSI exactly at the time the FVG formed
                    const formedRSI = rsiValues[fvg.formedAt] || 50;
                    if (formedRSI >= RSI_BEARISH_MAX || formedRSI <= RSI_BEARISH_MIN) continue;

                    // 3. PD Zone: The entry price (midpoint) MUST be in the PREMIUM zone relative to the range at formation
                    // if (midpoint <= fvgEquilibrium) continue;

                    // -----------------------------

                    if (curr.high > fvg.top) {

                        fvg.filled = true;

                        fvg.filledAt = curr.time;

                        activeFVGs.splice(j, 1);

                        j--;

                        continue;

                    }

                    const entryCondition = params.type === 'live_signal' ? true : (curr.high >= midpoint && curr.low <= midpoint);
                    if (entryCondition) {

                        // 🕒 Only enter trades AFTER simulationStart

                        if (curr.time < simulationStart) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const gapSize = fvg.top - fvg.bottom;

                        const buffer = gapSize * BEARISH_SL_BUFFER_RATIO;

                        const riskPerUnit = Math.abs((fvg.top + buffer) - midpoint);

                        if (riskPerUnit < MIN_RISK_PER_UNIT) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const unitsPrecision = staticData.qtyStep.toString().split('.')[1]?.length || 0;

                        let units = riskAmount / riskPerUnit;

                        units = Number(units.toFixed(unitsPrecision));

                        // Enforce minimum quantity based on STATIC_INSTRUMENTS (minNotional & qtyStep)

                        const minNotional = staticData.minNotional || DEFAULT_MIN_NOTIONAL;

                        const minQty = Math.ceil((minNotional / midpoint) / staticData.qtyStep) * staticData.qtyStep;

                        if (units < minQty || units <= 0) {

                            fvg.filled = true;

                            fvg.filledAt = curr.time;

                            activeFVGs.splice(j, 1);

                            j--;

                            continue;

                        }

                        const tp = Number((midpoint - (riskPerUnit * rr)).toFixed(pricePrecision));

                        const sl = Number((midpoint + riskPerUnit).toFixed(pricePrecision));

                        activeTrade = {

                            entryTime: dayjs(curr.time).tz(TRADE_TIMEZONE).format(),

                            direction: "sell",

                            entryPrice: midpoint,

                            units: units,

                            sl: sl,

                            tp: tp,

                            resolution: params.resolution || DEFAULT_RESOLUTION,

                            status: "open",

                            orderType: "limit_order",

                            profit: 0,

                            indicators: { fvgTop: fvg.top, fvgBottom: fvg.bottom }

                        };

                        // --- INTRA-CANDLE EXIT CHECK ---

                        const exitInfo = this.checkIntraCandleExit(activeTrade, curr, subCandles);

                        if (exitInfo) {

                            activeTrade.status = "closed";

                            activeTrade.exitPrice = exitInfo.price;

                            activeTrade.exitTime = exitInfo.time;

                            activeTrade.exitReason = exitInfo.reason;

                            const { profit, fee } = this.calculatePnL(activeTrade, activeTrade.exitPrice, balance);

                            activeTrade.profit = profit;

                            activeTrade.pnlPercent = (profit / balance) * 100;

                            balance += profit;

                            trades.push({ ...activeTrade });

                            activeTrade = null;

                            lastExitIndex = i;

                        }

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

    private checkIntraCandleExit(trade: Trade, mainCandle: Candle, subCandles: Candle[]) {

        const isBuy = trade.direction === "buy";

        const sl = trade.sl || 0;

        const tp = trade.tp || 0;

        // 1. Check Sub-Candles if available (High Precision)

        if (subCandles && subCandles.length > 0) {

            const entryUnix = dayjs(trade.entryTime).valueOf();

            const res = (trade as any).resolution || DEFAULT_RESOLUTION;

            const intervalMs = Number(res) * 60 * 1000;

            const candleEndUnix = mainCandle.time + intervalMs;

            const relevantSubs = subCandles.filter(s => s.time >= entryUnix && s.time < candleEndUnix);

            for (const sub of relevantSubs) {

                if (isBuy) {

                    if (sub.low <= sl) return { price: sl, time: dayjs(sub.time).tz(TRADE_TIMEZONE).format(), reason: "Stop Loss (Sub)" };

                    if (sub.high >= tp) return { price: tp, time: dayjs(sub.time).tz(TRADE_TIMEZONE).format(), reason: "Take Profit (Sub)" };

                } else {

                    if (sub.high >= sl) return { price: sl, time: dayjs(sub.time).tz(TRADE_TIMEZONE).format(), reason: "Stop Loss (Sub)" };

                    if (sub.low <= tp) return { price: tp, time: dayjs(sub.time).tz(TRADE_TIMEZONE).format(), reason: "Take Profit (Sub)" };

                }

            }

        }

        // 2. Fallback to Main Candle High/Low (Low Precision)

        if (isBuy) {

            if (mainCandle.low <= sl) return { price: sl, time: dayjs(mainCandle.time).tz(TRADE_TIMEZONE).format(), reason: "Stop Loss" };

            if (mainCandle.high >= tp) return { price: tp, time: dayjs(mainCandle.time).tz(TRADE_TIMEZONE).format(), reason: "Take Profit" };

        } else {

            if (mainCandle.high >= sl) return { price: sl, time: dayjs(mainCandle.time).tz(TRADE_TIMEZONE).format(), reason: "Stop Loss" };

            if (mainCandle.low <= tp) return { price: tp, time: dayjs(mainCandle.time).tz(TRADE_TIMEZONE).format(), reason: "Take Profit" };

        }

        return null;

    }

    private calculatePnL(trade: Trade, exitPrice: number, balance: number) {

        const units = trade.units || 0;

        const grossProfit = trade.direction === "buy"

            ? (exitPrice - trade.entryPrice) * units

            : (trade.entryPrice - exitPrice) * units;

        // Calculate fee dynamically based on exit reason
        const isTakeProfit = trade.exitReason === "Take Profit" || trade.exitReason === "Take Profit (Sub)";
        const exitFeeRate = isTakeProfit ? MAKER_FEE_RATE : TAKER_FEE_RATE;

        const entryFee = trade.entryPrice * units * MAKER_FEE_RATE;
        const exitFee = exitPrice * units * exitFeeRate;
        const totalFee = entryFee + exitFee;

        return { profit: grossProfit - totalFee, fee: totalFee };

    }

    private checkSignal(candles: Candle[], params: Record<string, any>): { matched: boolean, trade?: Trade } {

        if (candles.length < 5) return { matched: false };

        // We only care about the last N candles to detect relevant FVGs

        const lookback = Math.min(candles.length, LIVE_SIGNAL_LOOKBACK);

        const relevantCandles = candles.slice(-lookback);

        // Re-run the FVG detection on the subset

        const result = this.run(relevantCandles, { ...params, type: 'live_signal' });

        return {

            matched: !!result.trade,

            trade: result.trade

        };

    }

}
