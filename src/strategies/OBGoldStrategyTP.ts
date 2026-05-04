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
    description = '3:45–4:00 IST range breakout with fixed ATR SL and TP';

    private static rangeHigh: number | null = null;
    private static rangeLow: number | null = null;
    private static rangeCaptured = false;
    private static pendingBreakout: {
        direction: 'buy' | 'sell',
        breakoutHigh: number,
        breakoutLow: number,
        validUntil: number
    } | null = null;
    private static dailyTradeCount = 0;
    private static lastResetDay: string | null = null;

    run(
        candles: Candle[],
        params: Record<string, any>,
        subCandles: Candle[] = []
    ): any {
        if (params.type === 'live') {
            return this.checkSignal(candles, params);
        }
        console.log("🚀 ~ GoldOpeningBreakout ~ run ~ candles:", candles.length)

        const {
            capital = 1000,
            feeRate = 0.0005,
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
        let dailyTradeCount = 0;

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
                dailyTradeCount = 0;
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
            if (hour === 3 && minute === 45) {
                rangeHigh = c.high;
                rangeLow = c.low;
                continue;
            }

            if (hour === 4 && minute === 0) {
                const combinedHigh = Math.max(rangeHigh || 0, c.high);
                const combinedLow = Math.min(rangeLow || 999999, c.low);
                const totalRange = combinedHigh - combinedLow;

                if (totalRange > 10) {
                    console.log(`[Gold] ⚠️ Range gap (${totalRange.toFixed(2)}) > 50. Using 3:45 range only.`);
                    // rangeHigh and rangeLow are already set to 3:45 values
                } else {
                    console.log(`[Gold] ✅ Range gap (${totalRange.toFixed(2)}) OK. Using combined 3:45-4:00 range.`);
                    rangeHigh = combinedHigh;
                    rangeLow = combinedLow;
                }

                rangeCaptured = true;
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
                                dailyTradeCount++;
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
                                dailyTradeCount++;
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
            if (!currentTrade && !pendingBreakout && rangeCaptured && rangeHigh && rangeLow && dailyTradeCount === 0) {
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

                    if (bodyPercentage < 0.4) {
                        direction = null; // Reject trade
                        console.log(`[Gold] REJECTED Breakout @ ${c.close} (Body too small: ${(bodyPercentage * 100).toFixed(1)}%)`);
                    }
                }

                // 📏 ENTRY DISTANCE CHECK (MIN 5 POINTS)
                if (direction) {
                    if (direction === 'buy') {
                        const distance = c.high - rangeHigh!;
                        if (distance < 5) {
                            console.log(`[Gold] REJECTED BUY @ ${c.close} (Breakout High too far: ${distance.toFixed(2)} pts)`);
                            direction = null;
                        }
                    } else if (direction === 'sell') {
                        const distance = rangeLow! - c.low;
                        if (distance < 5) {
                            console.log(`[Gold] REJECTED SELL @ ${c.close} (Breakout Low too far: ${distance.toFixed(2)} pts)`);
                            direction = null;
                        }
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

    private checkSignal(candles: Candle[], params: Record<string, any>): { matched: boolean, trade?: Trade } {
        if (candles.length < 10) return { matched: false };

        const settings = params;
        const now = dayjs().tz('Asia/Kolkata');
        const currentDay = now.format('YYYY-MM-DD');
        const currentHour = now.hour();
        const currentMinute = now.minute();

        // 🔄 RESET SESSION at 3:30 AM IST or New Day
        const isResetTime = currentHour === 3 && currentMinute === 30;
        if (TpGoldOpeningBreakout.lastResetDay !== currentDay || isResetTime) {
            TpGoldOpeningBreakout.rangeHigh = null;
            TpGoldOpeningBreakout.rangeLow = null;
            TpGoldOpeningBreakout.rangeCaptured = false;
            TpGoldOpeningBreakout.pendingBreakout = null;
            TpGoldOpeningBreakout.dailyTradeCount = 0;
            if (TpGoldOpeningBreakout.lastResetDay !== currentDay) {
                TpGoldOpeningBreakout.lastResetDay = currentDay;
                console.log(`[Gold-Live] 🔄 New day reset: ${currentDay}`);
            }
        }

        const i = candles.length - 1;
        const c = candles[i];
        if (!c) return { matched: false };

        const time = dayjs(c.time).tz('Asia/Kolkata');
        const hour = time.hour();
        const minute = time.minute();

        // 🚫 Lockout Check
        if (params.hasTradedToday || TpGoldOpeningBreakout.dailyTradeCount > 0) {
            return { matched: false };
        }

        // 🟡 CAPTURE RANGE (3:45 AM → 4:00 AM) IST
        if (hour === 3 && minute === 45) {
            TpGoldOpeningBreakout.rangeHigh = c.high;
            TpGoldOpeningBreakout.rangeLow = c.low;
        }

        if (hour === 4 && minute === 0) {
            const combinedHigh = Math.max(TpGoldOpeningBreakout.rangeHigh || 0, c.high);
            const combinedLow = Math.min(TpGoldOpeningBreakout.rangeLow || 999999, c.low);
            const totalRange = combinedHigh - combinedLow;

            if (totalRange <= 10) {
                TpGoldOpeningBreakout.rangeHigh = combinedHigh;
                TpGoldOpeningBreakout.rangeLow = combinedLow;
            }
            TpGoldOpeningBreakout.rangeCaptured = true;
            console.log(`[Gold-Live] ✅ Range Captured: ${TpGoldOpeningBreakout.rangeHigh} - ${TpGoldOpeningBreakout.rangeLow}`);
        }

        // 🟢 ENTRY LOGIC (IDENTIFY BREAKOUT)
        if (!TpGoldOpeningBreakout.rangeCaptured || TpGoldOpeningBreakout.pendingBreakout) {
            return { matched: false };
        }

        // 🚫 DO NOT enter new trades after 11:30 PM IST
        if (hour === 23 && minute >= 30) {
            return { matched: false };
        }

        const prevCandle = candles[i - 1];
        if (!prevCandle) return { matched: false };

        const breakoutBuffer = params.breakoutBuffer || 2;
        const breakoutHigh = TpGoldOpeningBreakout.rangeHigh! + breakoutBuffer;
        const breakoutLow = TpGoldOpeningBreakout.rangeLow! - breakoutBuffer;

        let direction: 'buy' | 'sell' | null = null;

        if (prevCandle.close < breakoutHigh && c.close >= breakoutHigh) {
            direction = 'buy';
        } else if (prevCandle.close > breakoutLow && c.close <= breakoutLow) {
            direction = 'sell';
        }

        if (direction) {
            // BODY SIZE CHECK
            const totalRange = c.high - c.low;
            const bodySize = Math.abs(c.open - c.close);
            const bodyPercentage = totalRange > 0 ? (bodySize / totalRange) : 0;

            if (bodyPercentage < 0.4) {
                console.log(`[Gold-Live] ❌ REJECTED: Body too small (${(bodyPercentage * 100).toFixed(1)}%)`);
                direction = null;
            }
        }

        if (direction) {
            // DISTANCE CHECK
            if (direction === 'buy') {
                const distance = c.high - TpGoldOpeningBreakout.rangeHigh!;
                if (distance < 5) direction = null;
            } else {
                const distance = TpGoldOpeningBreakout.rangeLow! - c.low;
                if (distance < 5) direction = null;
            }
        }

        if (direction) {
            TpGoldOpeningBreakout.pendingBreakout = {
                direction,
                breakoutHigh: c.high,
                breakoutLow: c.low,
                validUntil: c.time + (30 * 60 * 1000) // 30 minutes from candle start = 15 minutes from candle close
            };
            console.log(`[Gold-Live] 🔔 PENDING ${direction.toUpperCase()} detected. Waiting for sweep of H:${c.high} L:${c.low}`);
        }

        return { matched: false }; // We only return matched:true in checkPendingBreakout
    }

    public static checkPendingBreakout(candle: Candle, params: any): { matched: boolean, trade?: Trade } {
        if (!TpGoldOpeningBreakout.pendingBreakout) return { matched: false };

        const pb = TpGoldOpeningBreakout.pendingBreakout;
        const now = candle.time;

        if (now > pb.validUntil) {
            console.log(`[Gold-Live] ⌛ Pending breakout EXPIRED.`);
            TpGoldOpeningBreakout.pendingBreakout = null;
            return { matched: false };
        }

        let triggered = false;
        if (pb.direction === 'buy' && candle.high >= pb.breakoutHigh) {
            triggered = true;
        } else if (pb.direction === 'sell' && candle.low <= pb.breakoutLow) {
            triggered = true;
        }

        if (triggered) {
            console.log(`[Gold-Live] 🚀 TRIGGERED! Swept ${pb.direction === 'buy' ? pb.breakoutHigh : pb.breakoutLow}`);
            const instance = new TpGoldOpeningBreakout();
            const slPrice = pb.direction === 'buy' ? pb.breakoutLow : pb.breakoutHigh;
            const trade = instance.createTrade(
                pb.direction === 'buy' ? pb.breakoutHigh : pb.breakoutLow,
                pb.direction,
                slPrice,
                candle.time,
                params
            );

            TpGoldOpeningBreakout.pendingBreakout = null;
            TpGoldOpeningBreakout.dailyTradeCount++;
            return { matched: true, trade };
        }

        return { matched: false };
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
        let tp = direction === 'buy' ? entryPrice + (risk * 2) : entryPrice - (risk * 2);

        console.log(`[Gold-Trade] 🛠️ Creating ${direction} trade. Entry:${entryPrice}, SL-Price:${slPrice}, Risk:${risk.toFixed(2)}, TP-Target:${tp.toFixed(2)}`);

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
            units
        };
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

