import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

import type { Candle, Trade } from '../types/index.js';
import type { Strategy } from './index.js';
import { calculateUnits, calculateTradeProfit } from './StrategyUtils.js';
import { TradeService } from '../services/TradeService.js';

export class GoldOpeningBreakout implements Strategy {
    id = 'gold-opening-breakout';
    name = 'Gold Opening Breakout';
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

        let rangeHigh: number | null = null;
        let rangeLow: number | null = null;
        let rangeCaptured = false;

        let subIdx = 0;

        const simulationStart = params.simulationStartUnix ? params.simulationStartUnix * 1000 : 0;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (!c) continue;

            // 🕒 Only process ranges and entries after simulationStart
            if (c.time < simulationStart) continue;

            const time = dayjs(c.time).tz('Asia/Kolkata');
            const hour = time.hour();
            const minute = time.minute();

            // 🔴 RESET SESSION at 3:30 AM IST
            if (hour === 3 && minute === 30) {
                rangeHigh = null;
                rangeLow = null;
                rangeCaptured = false;
                currentTrade = null;
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

            // 🔵 MANAGE ACTIVE TRADE
            if (currentTrade) {
                const trade = currentTrade;

                const nextTime = candles[i + 1]
                    ? candles[i + 1]!.time
                    : c.time + 60000;

                const currentSubs: Candle[] = [];

                while (subIdx < subCandles.length && subCandles[subIdx].time < nextTime) {
                    currentSubs.push(subCandles[subIdx]);
                    subIdx++;
                }

                const simulation = currentSubs.length ? currentSubs : [c];

                for (const sc of simulation) {
                    const scTime = dayjs(sc.time).tz('Asia/Kolkata');
                    const h = scTime.hour();
                    const m = scTime.minute();

                    // 🔻 TRAILING SL
                    GoldOpeningBreakout.updateTrailingSL(trade, sc, params);

                    // 🔻 SL HIT
                    if (trade.direction === 'buy' && trade.sl && sc.low <= trade.sl) {
                        trade.exitPrice = trade.sl;
                        trade.exitReason = 'SL';
                        trade.status = 'closed';
                        trade.exitTime = scTime.toISOString();
                    }

                    if (trade.direction === 'sell' && trade.sl && sc.high >= trade.sl) {
                        trade.exitPrice = trade.sl;
                        trade.exitReason = 'SL';
                        trade.status = 'closed';
                        trade.exitTime = scTime.toISOString();
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
                        break;
                    }
                }

                continue;
            }

            // 🟢 ENTRY LOGIC
            if (!currentTrade && rangeCaptured && rangeHigh && rangeLow) {
                let direction: 'buy' | 'sell' | null = null;

                const prevCandle = candles[i - 1];
                if (!prevCandle) continue;

                const breakoutHigh = rangeHigh + breakoutBuffer;
                const breakoutLow = rangeLow - breakoutBuffer;

                // Only trigger if it's a FRESH CROSSING
                if (prevCandle.high < breakoutHigh && c.high >= breakoutHigh) {
                    direction = 'buy';
                } else if (prevCandle.low > breakoutLow && c.low <= breakoutLow) {
                    direction = 'sell';
                }

                if (direction) {
                    currentTrade = this.createTrade(
                        c,
                        direction,
                        candles,
                        i,
                        balance,
                        atrMultiplierSL,
                        params
                    );

                    console.log(`[Gold] ENTRY ${direction} @ ${c.close} (Crossing detected)`);
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
        c: Candle,
        direction: 'buy' | 'sell',
        candles: Candle[],
        i: number,
        balance: number,
        atrMultiplier: number,
        params: any
    ): Trade {
        const entry = c.close;
        const atr = this.calculateATR(candles, 14, i);
        const offset = atr * atrMultiplier;

        let sl =
            direction === 'buy'
                ? entry - offset
                : entry + offset;

        // 🎯 Apply Precision
        const cleanPair = (params.pair || 'B-XAU_USDT').replace('B-', '').toLowerCase();
        const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[params.pair] || TradeService.STATIC_INSTRUMENTS['B-XAU_USDT'] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
        sl = Number(sl.toFixed(pricePrecision));

        const units = calculateUnits(entry, sl, {
            capital: balance,
            maxPositionSize: params.maxPositionSize || 100,
            feeRate: params.feeRate || 0.0005,
            leverage: params.leverage || 1
        });

        return {
            entryTime: dayjs(c.time).tz('Asia/Kolkata').toISOString(),
            direction,
            entryPrice: entry,
            sl,
            initialSL: sl,
            status: 'open',
            profit: 0,
            units,
            lastHigh: entry,
            lastLow: entry,
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