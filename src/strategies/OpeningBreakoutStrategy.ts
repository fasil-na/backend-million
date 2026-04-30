import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';
import { calculateUnits, calculateTradeProfit } from './StrategyUtils.js';
import { TradeService } from '../services/TradeService.js';



export class OpeningBreakoutStrategy implements Strategy {
    id = 'opening-breakout';
    name = 'Opening Breakout';
    description = 'Trades based on the high/low of an opening time window with EMA and ATR filters.';
    run(candles: Candle[], params: Record<string, any>, subCandles: Candle[] = []): { trades: Trade[], finalBalance: number, activeTrade?: Trade | null } | { matched: boolean } {
        const { type = 'backtest', capital = 1000 } = params;
        if (type === 'live') {
            const result = this.checkSignal(candles, params);
            return result;
        }

        console.log(`[Backtest] 🚀 Starting simulation: ${candles.length} candles, Initial Capital: ${capital}`);
        console.log(`[Backtest] 🕒 Params - simulationStartUnix: ${params.simulationStartUnix} (${params.simulationStartUnix ? dayjs.unix(params.simulationStartUnix).utc().format('YYYY-MM-DD HH:mm:ss') : 'N/A'})`);

        if (candles.length < 10) return { trades: [], finalBalance: capital };

        const {
            feeRate = 0.0005,
            simulationStartUnix = 0,
            atrMultiplierSL = 1.0
        } = params;



        let currentBalance = capital;
        const closes = candles.map(c => c.close);
        let allTrades: Trade[] = [];
        let currentTrade: Trade | null = null;
        let rangeHigh: number | null = null;
        let rangeLow: number | null = null;
        let direction: 'buy' | 'sell' | null = null;
        let lastBreakoutTime: string | null = null;
        let subIdx = 0;
        let lastDay: string | null = null;
        let dayCandleCount = 0;
        const openingWindow = 20;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (currentBalance <= 0) {
                console.log("BANKRUPTCY: Balance hit 0, stopping strategy.");
                break;
            }

            if (!c) continue;

            const tz = params.timezone === 'IST' ? 'Asia/Kolkata' : 'UTC';
            const time = tz === 'UTC' ? dayjs(c.time).utc() : dayjs(c.time).tz(tz);
            const currentDay = time.format('YYYY-MM-DD');

            // Reset range at the start of a new day
            if (currentDay !== lastDay) {
                lastDay = currentDay;
                rangeHigh = null;
                rangeLow = null;
                dayCandleCount = 0;
            }

            dayCandleCount++;

            // Define the opening range during the first 20 candles of the day (openingWindow)
            if (dayCandleCount <= openingWindow) {
                if (rangeHigh === null || c.high > rangeHigh) rangeHigh = c.high;
                if (rangeLow === null || c.low < rangeLow) rangeLow = c.low;

                if (dayCandleCount === openingWindow) {
                    console.log(`[Backtest] 🌅 Opening Range Finalized for ${currentDay}: High=${rangeHigh}, Low=${rangeLow}`);
                }
                continue; // Cannot trade during the opening window
            }

            if (currentTrade) {
                const trade = currentTrade; // Local refinement for TS
                const { trailingSL = true } = params;

                // Sync subIdx to current candle start
                while (subIdx < subCandles.length && subCandles[subIdx]!.time < c.time) {
                    subIdx++;
                }

                // Get sub-candles for this period (e.g. the 15 1m candles inside this 15m candle)
                const nextCandleTime = candles[i + 1] ? candles[i + 1]!.time : c.time + 3600000; // fallback 1h
                const currentSubCandles: Candle[] = [];
                while (subIdx < subCandles.length && subCandles[subIdx]!.time < nextCandleTime) {
                    currentSubCandles.push(subCandles[subIdx]!);
                    subIdx++;
                }

                // If no sub-candles, fallback to using the main candle itself
                const simulationPass = currentSubCandles.length > 0 ? currentSubCandles : [c];

                for (const sc of simulationPass) {
                    const tz = params.timezone === 'IST' ? 'Asia/Kolkata' : 'UTC';
                    const scTime = tz === 'UTC' ? dayjs(sc.time).utc() : dayjs(sc.time).tz(tz);

                    if (trailingSL) {
                        const oldSL = trade.sl;
                        OpeningBreakoutStrategy.updateTrailingSL(trade, sc);

                        // 🎯 Round SL dynamically exactly like the Live execution does
                        const cleanPair = (params.pair || '').replace('B-', '').toLowerCase();
                        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-' + params.pair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
                        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
                        trade.sl = Number((trade.sl ?? trade.entryPrice).toFixed(pricePrecision));

                        if (trade.sl !== oldSL) {
                            console.log(`[Backtest] 📈 Trailing SL Updated: ${oldSL} -> ${trade.sl} at ${scTime.format('HH:mm:ss')} (Price: ${sc.close})`);
                        }
                    }

                    if (trade.direction === 'buy') {
                        // Check SL on 1m Low (more realistic liquidation)
                        if (trade.sl !== undefined && sc.low <= trade.sl) {
                            console.log(`[Backtest] 🛑 SL Hit (Buy): Low=${sc.low} <= SL=${trade.sl} at ${scTime.format('HH:mm:ss')}`);
                            trade.exitPrice = trade.sl;
                            trade.exitReason = 'SL (1m)';
                            trade.status = 'closed';
                            trade.exitTime = scTime.toISOString();
                        }
                    } else {
                        // Check SL on 1m High
                        if (trade.sl !== undefined && sc.high >= trade.sl) {
                            console.log(`[Backtest] 🛑 SL Hit (Sell): High=${sc.high} >= SL=${trade.sl} at ${scTime.format('HH:mm:ss')}`);
                            trade.exitPrice = trade.sl;
                            trade.exitReason = 'SL (1m)';
                            trade.status = 'closed';
                            trade.exitTime = scTime.toISOString();
                        }
                    }

                    if (trade.status === 'closed') {
                        const { profit, fee } = calculateTradeProfit(trade, trade.exitPrice!, feeRate);
                        trade.fee = fee;
                        trade.profit = profit;

                        console.log(`[Backtest] 💰 Trade Closed: ${trade.direction.toUpperCase()} Exit=${trade.exitPrice}, Profit=${profit.toFixed(2)}, New Balance=${(currentBalance + profit).toFixed(2)}`);

                        // 📸 DEEP SNAPSHOT: Freeze the trade and its history array
                        // to prevent reference loss during simulation.
                        allTrades.push(JSON.parse(JSON.stringify(trade)));

                        currentBalance += profit;
                        currentTrade = null;
                        break; // Exit the sub-candle loop
                    }
                }
                continue; // Move to next candle since we already have an active trade
            }

            if (!rangeHigh || !rangeLow) continue;
            if (simulationStartUnix && c.time < simulationStartUnix * 1000) continue;

            const ema20 = this.calculateEMA(closes, 20, i);
            const ema50 = this.calculateEMA(closes, 50, i);
            if (Math.abs(ema20 - ema50) < 15) continue;

            const body = Math.abs(c.close - c.open);
            const range = c.high - c.low;
            if (range <= 0 || body / range <= 0.6) continue;
            if (c.volume <= this.avgVolume(candles, i) * 1.3) continue;
            if (Math.abs(c.close - ema20) < 10) continue;

            if (!currentTrade) {
                const signal = this.getSignal(candles, i, rangeHigh, rangeLow);
                if (signal) {
                    console.log(`[Backtest] 🎯 Signal Triggered: ${signal.toUpperCase()} at ${time.format('HH:mm:ss')} (Price: ${c.close})`);
                    direction = signal;
                    lastBreakoutTime = time.toISOString();
                    currentTrade = this.calculateEntryParams(c, direction, candles, i, currentBalance, params);
                    console.log(`[Backtest] 🚀 Trade Entered: ${direction.toUpperCase()} Entry=${currentTrade.entryPrice}, SL=${currentTrade.sl}, Units=${currentTrade.units?.toFixed(4)}`);
                    rangeHigh = null;
                    rangeLow = null;
                }
            }
        }

        return {
            trades: allTrades,
            finalBalance: currentBalance,
            activeTrade: currentTrade ? JSON.parse(JSON.stringify(currentTrade)) : null
        };
    }

    /**
     * Reusable Trailing Stop Loss function
     */
    public static updateTrailingSL(trade: Trade, candle: Candle): void {
        const currentPrice = candle.close;

        if (trade.direction === 'buy') {
            const lastHigh = trade.lastHigh ?? trade.entryPrice;
            if (candle.high > lastHigh) {
                const move = candle.high - lastHigh;
                const newSl = (trade.sl || trade.entryPrice) + move;

                // Only move SL if it's a significant change (> 0.01%) to prevent spam/desync
                const change = Math.abs(newSl - (trade.sl || trade.entryPrice));
                const threshold = (trade.sl || trade.entryPrice) * 0.0001;

                if (newSl < currentPrice && change > threshold) {
                    trade.sl = newSl;
                    trade.lastHigh = candle.high;
                    trade.trailingCount = (trade.trailingCount || 0) + 1;
                    // Force ensure history array exists
                    if (!trade.trailingHistory) trade.trailingHistory = [];

                    trade.trailingHistory.push({
                        sl: Number(newSl.toFixed(4)),
                        marketPrice: Number(currentPrice.toFixed(4)),
                        time: dayjs(candle.time).toISOString()
                    });
                }
            }
        } else {
            const lastLow = trade.lastLow ?? trade.entryPrice;
            if (candle.low < lastLow) {
                const move = lastLow - candle.low;
                const newSl = (trade.sl || trade.entryPrice) - move;

                const change = Math.abs(newSl - (trade.sl || trade.entryPrice));
                const threshold = (trade.sl || trade.entryPrice) * 0.0001;

                if (newSl > currentPrice && change > threshold) {
                    trade.sl = newSl;
                    trade.lastLow = candle.low;
                    trade.trailingCount = (trade.trailingCount || 0) + 1;
                    console.log(trade.trailingCount, 'hitting-------123')
                    if (!trade.trailingHistory) trade.trailingHistory = [];

                    trade.trailingHistory.push({
                        sl: Number(newSl.toFixed(4)),
                        marketPrice: Number(currentPrice.toFixed(4)),
                        time: dayjs(candle.time).toISOString()
                    });
                }
            }
        }
    }

    private getSignal(candles: Candle[], i: number, rangeHigh: number | null, rangeLow: number | null): 'buy' | 'sell' | null {
        if (!rangeHigh || !rangeLow) return null;
        const c = candles[i];
        if (!c) return null;

        const closes = candles.map(candle => candle.close);
        const ema20 = this.calculateEMA(closes, 20, i);
        const ema50 = this.calculateEMA(closes, 50, i);

        if (Math.abs(ema20 - ema50) < 5) return null;

        const body = Math.abs(c.close - c.open);
        const range = c.high - c.low;
        if (range <= 0 || body / range <= 0.6) return null;
        if (c.volume <= this.avgVolume(candles, i) * 1.3) return null;
        if (Math.abs(c.close - ema20) < 10) return null;

        if (c.high > rangeHigh && ema20 > ema50) {
            console.log(`[Backtest] ✅ Buy Signal Confirmed: Price(${c.high}) > RangeHigh(${rangeHigh}) and EMA20(${ema20.toFixed(2)}) > EMA50(${ema50.toFixed(2)})`);
            return 'buy';
        }
        if (c.low < rangeLow && ema20 < ema50) {
            console.log(`[Backtest] ✅ Sell Signal Confirmed: Price(${c.low}) < RangeLow(${rangeLow}) and EMA20(${ema20.toFixed(2)}) < EMA50(${ema50.toFixed(2)})`);
            return 'sell';
        }

        return null;
    }

    private calculateEntryParams(c: Candle, direction: 'buy' | 'sell', candles: Candle[], i: number, balance: number, params: Record<string, any>): Trade {
        const { atrMultiplierSL = 1, maxPositionSize = 100, feeRate = 0.0005, leverage = 1 } = params;
        const entry = c.close;
        const atr = Math.abs(this.calculateATR(candles, 14, i));
        const multiplier = Math.abs(atrMultiplierSL);
        const offset = atr * multiplier;

        let sl = direction === 'buy' ? entry - offset : entry + offset;

        // 🛑 CRITICAL SANITY GUARD: Ensure SL is on the correct side of Entry
        if (direction === 'buy' && sl >= entry) {
            console.error(`[OpeningBreakout] 🚨 BLUNDER DETECTED: Buy SL (${sl}) >= Entry (${entry}). Correcting to forced offset.`);
            sl = entry - (entry * 0.01); // Force 1% SL as emergency fallback
        } else if (direction === 'sell' && sl <= entry) {
            console.error(`[OpeningBreakout] 🚨 BLUNDER DETECTED: Sell SL (${sl}) <= Entry (${entry}). Correcting to forced offset.`);
            sl = entry + (entry * 0.01);
        }

        // 🎯 Enforce Native Precision Rules on Entry Stop Loss
        const cleanPair = (params.pair || '').replace('B-', '').toLowerCase();
        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-' + params.pair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
        sl = Number(sl.toFixed(pricePrecision));

        const units = calculateUnits(entry, sl, {
            capital: balance,
            maxPositionSize,
            feeRate,
            leverage
        });

        return {
            entryTime: (params.timezone === 'IST' ? dayjs(c.time).tz('Asia/Kolkata') : dayjs(c.time).utc()).toISOString(),
            direction,
            entryPrice: entry,
            sl,
            status: 'open',
            profit: 0,
            lastHigh: entry,
            lastLow: entry,
            units,
            initialSL: sl,
            trailingCount: 0,
            trailingHistory: []
        };
    }

    private checkSignal(candles: Candle[], params: Record<string, any>): { matched: boolean, trade?: Trade } {
        if (candles.length < 10) return { matched: false };

        // 🛡️ One-and-Done Lockout: If the database reports we already traded today, do not evaluate!
        if (params.hasTradedToday) {
            return { matched: false };
        }
        // Evaluate signals on the most recently *closed* candle (length - 2),
        // because length - 1 is the brand new forming candle when this is triggered.
        const i = candles.length - 2;
        if (i < 0) return { matched: false };

        const c = candles[i];
        if (!c) return { matched: false };

        let rangeHigh: number | null = null;
        let rangeLow: number | null = null;
        const tz = params.timezone === 'IST' ? 'Asia/Kolkata' : 'UTC';
        const time = tz === 'UTC' ? dayjs(c.time).utc() : dayjs(c.time).tz(tz);
        const currentDay = time.format('YYYY-MM-DD');
        const openingWindow = 20; // 🛑 CRITICAL FIX: Synchronize with the identical 20-candle range window defined in backtester `run()`

        let dayCandleCount = 0;
        for (const candle of candles) {
            const candleTime = tz === 'UTC' ? dayjs(candle.time).utc() : dayjs(candle.time).tz(tz);
            if (candleTime.format('YYYY-MM-DD') === currentDay) {
                dayCandleCount++;
                if (dayCandleCount <= openingWindow) {
                    if (rangeHigh === null || candle.high > rangeHigh) rangeHigh = candle.high;
                    if (rangeLow === null || candle.low < rangeLow) rangeLow = candle.low;
                }
            }
        }

        if (dayCandleCount <= openingWindow) return { matched: false };

        const direction = this.getSignal(candles, i, rangeHigh, rangeLow);
        if (direction) {
            const trade = this.calculateEntryParams(c, direction, candles, i, params.capital || 1000, params);
            return { matched: true, trade };
        }

        return { matched: false };
    }

    private calculateEMA(data: number[], period: number, index: number): number {
        const k = 2 / (period + 1);
        // Use exactly 500 candles for EMA "warm-up" in both backtesting and live modes
        // to guarantee identically precise calculations regardless of total history loaded.
        const startIdx = Math.max(0, index - 500);
        let ema = data[startIdx] || 0;
        for (let i = startIdx + 1; i <= index; i++) {
            const val = data[i] || 0;
            ema = val * k + ema * (1 - k);
        }
        return ema;
    }

    private avgVolume(candles: Candle[], i: number, period = 20): number {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - period); j < i; j++) {
            const c = candles[j];
            if (c) {
                sum += c.volume;
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }

    private calculateATR(candles: Candle[], period = 14, index: number): number {
        let trs: number[] = [];
        for (let i = index - period + 1; i <= index; i++) {
            const c = candles[i];
            const prev = candles[i - 1];
            if (!c || !prev) continue;
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - prev.close),
                Math.abs(c.low - prev.close)
            );
            trs.push(tr);
        }
        return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
    }
}

