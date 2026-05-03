import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

import type { Candle, Trade } from '../types/index.js';

import type { Strategy } from './index.js';
import { calculateUnits, calculateTradeProfit } from './StrategyUtils.js';
import { TradeService } from '../services/TradeService.js';

export class TpGoldOpeningBreakout implements Strategy {
    id = 'tp-gold-opening-breakout';
    name = 'TpGold Opening Breakout';
    description = '3:45–4:00 IST range breakout with ATR SL and trailing SL';

    run(
        candles: Candle[],
        params: Record<string, any>,
        subCandles: Candle[] = []
    ): { trades: Trade[]; finalBalance: number; activeTrade?: Trade | null } {
        console.log("🚀 ~ GoldOpeningBreakout ~ run ~ candles:", candles.length)

        const {
            capital = 1000,
            feeRate = 0.0005,
            atrMultiplierSL = 1,
            breakoutBuffer = 2
        } = params;

        let balance = capital;
        let trades: Trade[] = [];
        
        let currentTrade: Trade | null = null;

        let pendingBreakout: { 
            direction: 'buy' | 'sell', 
            breakoutHigh: number, 
            breakoutLow: number, 
            validUntil: number
        } | null = null;

        let rangeHigh: number | null = null;
        let rangeLow: number | null = null;
        let rangeCaptured = false;

        let subIdx = 0;

        const simulationStart = params.simulationStartUnix ? params.simulationStartUnix * 1000 : 0;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (!c) continue;

            const nextTime = candles[i + 1] ? candles[i + 1]!.time : c.time + 60000;
            const currentSubs: Candle[] = [];
            while (subIdx < subCandles.length && subCandles[subIdx]!.time < nextTime) {
                currentSubs.push(subCandles[subIdx]!);
                subIdx++;
            }

            // 🕒 Only process ranges and entries after simulationStart
            if (c.time < simulationStart) continue;

            const time = dayjs(c.time).tz('Asia/Kolkata');
            const hour = time.hour();
            const minute = time.minute();
            const dayOfWeek = time.day();




            // 🔴 RESET SESSION at 3:30 AM IST
            if (hour === 3 && minute === 30) {
                rangeHigh = null;
                rangeLow = null;
                rangeCaptured = false;
                currentTrade = null;
                pendingBreakout = null;
            }

            // 🚫 WEEKEND FILTER: Skip Saturday (6) and Sunday (0) completely
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                if (currentTrade) {
                    const trade = currentTrade;
                    trade.exitPrice = c.open;
                    trade.exitReason = 'WEEKEND_FORCE_EXIT';
                    trade.status = 'closed';
                    trade.exitTime = time.toISOString();

                    const { profit, fee } = calculateTradeProfit(
                        trade,
                        trade.exitPrice,
                        feeRate
                    );

                    trade.profit = profit;
                    trade.fee = fee;

                    trades.push(JSON.parse(JSON.stringify(trade)));
                    balance += profit;
                    currentTrade = null;
                }
                pendingBreakout = null;
                continue;
            }

            // 🟡 CAPTURE RANGE (3:45 AM → 4:00 AM) IST
            if (
                (hour === 3 && minute >= 45) ||
                (hour === 4 && minute === 0)
            ) {
                if (rangeHigh === null || c.high > rangeHigh) rangeHigh = c.high;
                if (rangeLow === null || c.low < rangeLow) rangeLow = c.low;

                if (hour === 4 && minute === 0) {
                    rangeCaptured = true;
                    console.log(`[Gold] Range Locked (3:45AM-4:00AM): H=${rangeHigh}, L=${rangeLow}`);
                }

                continue;
            }

            // 🔵 MANAGE ACTIVE TRADE OR PENDING BREAKOUT
            if (currentTrade || pendingBreakout) {

                const simulation = currentSubs.length ? currentSubs : [c];

                for (const sc of simulation) {
                    const scTime = dayjs(sc.time).tz('Asia/Kolkata');
                    const h = scTime.hour();
                    const m = scTime.minute();

                    // 🔸 TRIGGER PENDING BREAKOUT
                    if (pendingBreakout && !currentTrade) {
                        if (sc.time >= pendingBreakout.validUntil) {
                            console.log(`[Gold] Pending Breakout EXPIRED at ${scTime.toISOString()}`);
                            pendingBreakout = null;
                        } else {
                            if (pendingBreakout.direction === 'buy' && sc.high >= pendingBreakout.breakoutHigh) {
                                currentTrade = this.createTrade(
                                    pendingBreakout.breakoutHigh,
                                    'buy',
                                    pendingBreakout.breakoutLow,
                                    sc.time,
                                    params
                                );
                                currentTrade.rangeHigh = rangeHigh!;
                                currentTrade.rangeLow = rangeLow!;
                                console.log(`[Gold] ENTRY BUY TRIGGERED @ ${pendingBreakout.breakoutHigh} (Sub-candle High Sweep)`);
                                pendingBreakout = null;
                            } else if (pendingBreakout.direction === 'sell' && sc.low <= pendingBreakout.breakoutLow) {
                                currentTrade = this.createTrade(
                                    pendingBreakout.breakoutLow,
                                    'sell',
                                    pendingBreakout.breakoutHigh,
                                    sc.time,
                                    params
                                );
                                currentTrade.rangeHigh = rangeHigh!;
                                currentTrade.rangeLow = rangeLow!;
                                console.log(`[Gold] ENTRY SELL TRIGGERED @ ${pendingBreakout.breakoutLow} (Sub-candle Low Sweep)`);
                                pendingBreakout = null;
                            }
                        }
                    }

                    // 🔵 MANAGE CURRENT TRADE
                    if (currentTrade) {
                        const trade = currentTrade;

                        // 🔻 SL & TP HIT
                        if (trade.direction === 'buy') {
                            if (trade.sl && sc.low <= trade.sl) {
                                trade.exitPrice = trade.sl;
                                trade.exitReason = 'SL';
                                trade.status = 'closed';
                                trade.exitTime = scTime.toISOString();
                            } else if (trade.tp && sc.high >= trade.tp) {
                                trade.exitPrice = trade.tp;
                                trade.exitReason = 'TP';
                                trade.status = 'closed';
                                trade.exitTime = scTime.toISOString();
                            }
                        }

                        if (trade.direction === 'sell') {
                            if (trade.sl && sc.high >= trade.sl) {
                                trade.exitPrice = trade.sl;
                                trade.exitReason = 'SL';
                                trade.status = 'closed';
                                trade.exitTime = scTime.toISOString();
                            } else if (trade.tp && sc.low <= trade.tp) {
                                trade.exitPrice = trade.tp;
                                trade.exitReason = 'TP';
                                trade.status = 'closed';
                                trade.exitTime = scTime.toISOString();
                            }
                        }

                        // 🔴 FORCE EXIT at 11:45 PM IST (EOD)
                        if (h === 23 && m >= 45) {
                            trade.exitPrice = sc.close;
                            trade.exitReason = 'EOD_FORCE_EXIT';
                            trade.status = 'closed';
                            trade.exitTime = scTime.toISOString();
                        }

                        if (trade.status === 'closed') {
                            const { profit, fee } = calculateTradeProfit(
                                trade,
                                trade.exitPrice!,
                                feeRate
                            );

                            trade.profit = profit;
                            trade.fee = fee;

                            trades.push(JSON.parse(JSON.stringify(trade)));
                            balance += profit;
                            currentTrade = null;
                            // Break out of sub-candle loop since trade is closed
                        }
                    }
                }

                continue;
            }

            // 🟢 ENTRY LOGIC (IDENTIFY BREAKOUT)
            if (!currentTrade && !pendingBreakout && rangeCaptured && rangeHigh && rangeLow) {
                // 🚫 DO NOT enter new trades after 11:30 PM IST to avoid end-of-day carryover
                if (hour === 23 && minute >= 30) {
                    continue;
                }

                let direction: 'buy' | 'sell' | null = null;

                const prevCandle = candles[i - 1];
                if (!prevCandle) continue;

                const breakoutHigh = rangeHigh + breakoutBuffer;
                const breakoutLow = rangeLow - breakoutBuffer;

                // Only trigger if it's a FRESH CROSSING
                if (prevCandle.close < breakoutHigh && c.close >= breakoutHigh) {
                    direction = 'buy';
                } else if (prevCandle.close > breakoutLow && c.close <= breakoutLow) {
                    direction = 'sell';
                }

                if (direction) {
                    // 🕯️ BODY SIZE CHECK: Breakout candle must have at least % body
                    const totalRange = c.high - c.low;
                    const bodySize = Math.abs(c.open - c.close);
                    const bodyPercentage = totalRange > 0 ? (bodySize / totalRange) : 0;

                    if (bodyPercentage < 0.85) {
                        direction = null; // Reject trade
                        console.log(`[Gold] REJECTED Breakout @ ${c.close} (Body too small: ${(bodyPercentage * 100).toFixed(1)}%)`);
                    }
                }

                if (direction) {
                    // Determine expiry (end of the next candle)
                    const nextNextTime = candles[i + 2] ? candles[i + 2]!.time : (c.time + 1800000);

                    pendingBreakout = {
                        direction,
                        breakoutHigh: c.high,
                        breakoutLow: c.low,
                        validUntil: nextNextTime
                    };

                    console.log(`[Gold] PENDING ${direction} Breakout Detected. Waiting for sub-candle sweep of High: ${c.high}, Low: ${c.low}`);
                }
            }
        }

        return {
            trades,
            finalBalance: balance,
            activeTrade: currentTrade
        };
    }

    // 🔧 CREATE TRADE
    private createTrade(
        entryPrice: number,
        direction: 'buy' | 'sell',
        slPrice: number,
        timeMs: number,
        params: any
    ): Trade {
        const risk = Math.abs(entryPrice - slPrice);
        let tp = direction === 'buy' ? entryPrice + (risk * 2.1) : entryPrice - (risk * 2.1);

        // 🎯 Apply Precision
        const cleanPair = (params.pair || 'B-XAU_USDT').replace('B-', '').toLowerCase();
        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-XAU_USDT'] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
        
        let sl = Number(slPrice.toFixed(pricePrecision));
        tp = Number(tp.toFixed(pricePrecision));

        const units = 0.01;

        return {
            entryTime: dayjs(timeMs).tz('Asia/Kolkata').toISOString(),
            direction,
            entryPrice,
            sl,
            initialSL: sl,
            tp,
            status: 'open',
            profit: 0,
            units,
            lastHigh: entryPrice,
            lastLow: entryPrice,
            trailingCount: 0,
            trailingHistory: []
        };
    }

    // 🔁 TRAILING SL
    static updateTrailingSL(trade: Trade, candle: Candle, params: any = {}) {
        const price = candle.close;
        const oldSL = trade.sl;

        if (trade.direction === 'buy') {
            if (candle.high > (trade.lastHigh || trade.entryPrice)) {
                const move = candle.high - (trade.lastHigh || trade.entryPrice);
                trade.sl = (trade.sl || trade.entryPrice) + move;
                trade.lastHigh = candle.high;
            }
        } else {
            if (candle.low < (trade.lastLow || trade.entryPrice)) {
                const move = (trade.lastLow || trade.entryPrice) - candle.low;
                trade.sl = (trade.sl || trade.entryPrice) - move;
                trade.lastLow = candle.low;
            }
        }

        if (trade.sl !== oldSL) {
            // 🎯 Apply Precision to Trail
            const cleanPair = (params.pair || 'B-XAU_USDT').replace('B-', '').toLowerCase();
            const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-XAU_USDT'] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
            const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
            trade.sl = Number(trade.sl!.toFixed(pricePrecision));

            trade.trailingCount = (trade.trailingCount || 0) + 1;
            if (!trade.trailingHistory) trade.trailingHistory = [];
            trade.trailingHistory.push({
                sl: trade.sl!,
                marketPrice: price,
                time: dayjs(candle.time).toISOString()
            });
        }
    }

    // 📊 ATR
    private calculateATR(candles: Candle[], period: number, index: number) {
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