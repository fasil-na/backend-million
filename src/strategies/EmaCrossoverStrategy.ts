import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';
import { calculateUnits, calculateTradeProfit } from './StrategyUtils.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export class EmaCrossoverStrategy implements Strategy {
    id = 'ema-crossover';
    name = 'EMA Crossover';
    description = 'Trades based on the crossover of two Exponential Moving Averages (EMA).';

    run(candles: Candle[], params: Record<string, any>, subCandles: Candle[] = []): { trades: Trade[], finalBalance: number, activeTrade?: Trade | null } | { matched: boolean, trade?: Trade } {
        const { type = 'backtest', capital = 1000 } = params;

        if (type === 'live') {
            return this.checkSignal(candles, params);
        }

        if (candles.length < 20) return { trades: [], finalBalance: capital };

        const {
            feeRate = 0.0005,
            simulationStartUnix = 0,
            trailingSL = true
        } = params;

        let currentBalance = capital;
        const closes = candles.map(c => c.close);
        let allTrades: Trade[] = [];
        let currentTrade: Trade | null = null;
        let subIdx = 0;

        for (let i =20; i < candles.length; i++) {
            const c = candles[i];
            if (currentBalance <= 0) {
                console.log("BANKRUPTCY: Balance hit 0, stopping strategy.");
                break;
            }
            if (!c) continue;
            
            if (simulationStartUnix && c.time < simulationStartUnix * 1000) continue;

            if (currentTrade) {
                const trade = currentTrade;

                // Sync subIdx to current candle start
                while (subIdx < subCandles.length && subCandles[subIdx]!.time < c.time) {
                    subIdx++;
                }

                const nextCandleTime = candles[i + 1] ? candles[i + 1]!.time : c.time + 3600000;
                const currentSubCandles: Candle[] = [];
                while (subIdx < subCandles.length && subCandles[subIdx]!.time < nextCandleTime) {
                    currentSubCandles.push(subCandles[subIdx]!);
                    subIdx++;
                }

                const simulationPass = currentSubCandles.length > 0 ? currentSubCandles : [c];

                for (const sc of simulationPass) {
                    const scTime = dayjs(sc.time).tz('Asia/Kolkata');

                    if (trailingSL) {
                        EmaCrossoverStrategy.updateTrailingSL(trade, sc);
                    }

                    if (trade.direction === 'buy') {
                        if (trade.sl !== undefined && sc.low <= trade.sl) {
                            trade.exitPrice = trade.sl;
                            trade.exitReason = 'SL';
                            trade.status = 'closed';
                            trade.exitTime = scTime.toISOString();
                        }
                    } else {
                        if (trade.sl !== undefined && sc.high >= trade.sl) {
                            trade.exitPrice = trade.sl;
                            trade.exitReason = 'SL';
                            trade.status = 'closed';
                            trade.exitTime = scTime.toISOString();
                        }
                    }

                    if (trade.status === 'closed') {
                        const { profit, fee } = calculateTradeProfit(trade, trade.exitPrice!, feeRate);
                        trade.fee = fee;
                        trade.profit = profit;
                        allTrades.push(trade);
                        currentBalance += profit;
                        currentTrade = null;
                        break;
                    }
                }
                
                // Exit signal on moving average crossback
                if (currentTrade) {
                    const fastEma = this.calculateEMA(closes, 9, i);
                    const slowEma = this.calculateEMA(closes, 10, i);
                    if (trade.direction === 'buy' && fastEma < slowEma) {
                        trade.exitPrice = c.close;
                        trade.exitReason = 'Signal Reversal';
                        trade.status = 'closed';
                        trade.exitTime = dayjs(c.time).tz('Asia/Kolkata').toISOString();
                    } else if (trade.direction === 'sell' && fastEma > slowEma) {
                        trade.exitPrice = c.close;
                        trade.exitReason = 'Signal Reversal';
                        trade.status = 'closed';
                        trade.exitTime = dayjs(c.time).tz('Asia/Kolkata').toISOString();
                    }

                    if (trade.status === 'closed') {
                        const { profit, fee } = calculateTradeProfit(trade, trade.exitPrice!, feeRate);
                        trade.fee = fee;
                        trade.profit = profit;
                        allTrades.push(trade);
                        currentBalance += profit;
                        currentTrade = null;
                    }
                }
                
                continue;
            }

            const signal = this.getSignal(candles, i);
            if (signal) {
                currentTrade = this.calculateEntryParams(c, signal, candles, i, currentBalance, params);
            }
        }

        return { trades: allTrades, finalBalance: currentBalance, activeTrade: currentTrade };
    }

    public static updateTrailingSL(trade: Trade, candle: Candle): void {
        if (trade.direction === 'buy') {
            const lastHigh = trade.lastHigh ?? trade.entryPrice;
            if (candle.high > lastHigh) {
                const move = candle.high - lastHigh;
                trade.sl = (trade.sl || trade.entryPrice) + move;
                trade.lastHigh = candle.high;
                trade.trailingCount = (trade.trailingCount || 0) + 1;
            }
        } else {
            const lastLow = trade.lastLow ?? trade.entryPrice;
            if (candle.low < lastLow) {
                const move = lastLow - candle.low;
                trade.sl = (trade.sl || trade.entryPrice) - move;
                trade.lastLow = candle.low;
                trade.trailingCount = (trade.trailingCount || 0) + 1;
            }
        }
    }

    private getSignal(candles: Candle[], i: number): 'buy' | 'sell' | null {
        if (i < 21) return null;
        const closes = candles.map(candle => candle.close);
        
        const fastEmaPrev = this.calculateEMA(closes, 9, i - 1);
        const slowEmaPrev = this.calculateEMA(closes, 10, i - 1);
        
        const fastEmaCurr = this.calculateEMA(closes, 9, i);
        const slowEmaCurr = this.calculateEMA(closes, 10, i);
        
        if (fastEmaPrev <= slowEmaPrev && fastEmaCurr > slowEmaCurr) return 'buy';
        if (fastEmaPrev >= slowEmaPrev && fastEmaCurr < slowEmaCurr) return 'sell';

        return null;
    }

    private calculateEntryParams(c: Candle, direction: 'buy' | 'sell', candles: Candle[], i: number, balance: number, params: Record<string, any>): Trade {
        const { atrMultiplierSL = 1.5, maxPositionSize = 100, feeRate = 0.0005, leverage = 1 } = params;
        const entry = c.close;
        const atr = this.calculateATR(candles, 14, i);
        const sl = direction === 'buy' ? entry - atr * atrMultiplierSL : entry + atr * atrMultiplierSL;

        const units = calculateUnits(entry, sl, {
            capital: balance,
            maxPositionSize,
            feeRate,
            leverage
        });

        return {
            entryTime: dayjs(c.time).tz('Asia/Kolkata').toISOString(),
            direction,
            entryPrice: entry,
            sl,
            status: 'open',
            profit: 0,
            lastHigh: entry,
            lastLow: entry,
            units
        };
    }

    private checkSignal(candles: Candle[], params: Record<string, any>): { matched: boolean, trade?: Trade } {
        if (candles.length < 21) return { matched: false };
        // Evaluate signals on the most recently *closed* candle (length - 2),
        // because length - 1 is the brand new forming candle when this is triggered.
        const i = candles.length - 2;
        if (i < 0) return { matched: false };
        
        const c = candles[i];
        if (!c) return { matched: false };

        const direction = this.getSignal(candles, i);
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

    private calculateATR(candles: Candle[], period = 14, index: number): number {
        let trs: number[] = [];
        for (let i = Math.max(1, index - period + 1); i <= index; i++) {
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
