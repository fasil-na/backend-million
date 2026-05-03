import { type Request, type Response } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { strategies } from '../strategies/index.js';
import type { Candle } from '../types/index.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export class DailyAnalysisController {
    static async getDailyAnalysis(req: Request, res: Response) {
        try {
            const { date, pair = "B-XAU_USDT" } = req.query;
            if (!date) return res.status(400).json({ error: "Date parameter is required (YYYY-MM-DD)" });

            // Create IST day boundaries
            const targetDay = dayjs.tz(date as string, 'Asia/Kolkata');
            const simStart = Math.floor(targetDay.startOf('day').valueOf() / 1000);
            const simEnd = Math.floor(targetDay.endOf('day').valueOf() / 1000);
            
            // Fetch 7 days of warmup data so EMA 200 and other indicators have enough history
            const fetchStart = simStart - (7 * 24 * 60 * 60);

            const [resMain, resSub] = await Promise.all([
                CoinDCXApiService.getCandlesticks({ pair, from: fetchStart, to: simEnd, resolution: '15' }),
                CoinDCXApiService.getCandlesticks({ pair, from: fetchStart, to: simEnd, resolution: '1' }).catch(() => ({ s: 'error', data: [] }))
            ]);

            if (resMain.s === 'no_data') {
                return res.json({
                    date,
                    rangeHigh: null,
                    rangeLow: null,
                    rangeTime: null,
                    tradesCount: 0,
                    trades: [],
                    dailyPnl: 0
                });
            }

            if (resMain.s !== 'ok' || !Array.isArray(resMain.data)) {
                console.error("CoinDCX API error:", resMain);
                return res.status(500).json({ error: "Failed to fetch market data", details: resMain });
            }

            const candles = resMain.data.sort((a: Candle, b: Candle) => a.time - b.time);
            const subCandles = Array.isArray(resSub.data) ? resSub.data.sort((a: Candle, b: Candle) => a.time - b.time) : [];

            // We will run a slightly modified version of the strategy just for analysis, or just run the base strategy 
            // and intercept the logs/ranges. Since we just reverted the main strategy, we can extract the range manually here!

            let rangeHigh: number | null = null;
            let rangeLow: number | null = null;
            let rangeTime: string | null = null;

            // Extract the 3:45-4:00 AM range for the target day
            for (const c of candles) {
                if (c.time < simStart * 1000) continue;
                if (c.time > simEnd * 1000) break;

                const t = dayjs(c.time).tz('Asia/Kolkata');
                const h = t.hour();
                const m = t.minute();

                if ((h === 3 && m >= 45) || (h === 4 && m === 0)) {
                    if (rangeHigh === null || c.high > rangeHigh) rangeHigh = c.high;
                    if (rangeLow === null || c.low < rangeLow) rangeLow = c.low;
                    if (h === 4 && m === 0) rangeTime = t.toISOString();
                }
            }

            // Run the actual strategy to get trades
            const strategy = strategies['tp-gold-opening-breakout'] as any;
            let trades: any[] = [];
            let dailyPnl = 0;

            if (strategy) {
                const result = strategy.run(candles, {
                    capital: 1000,
                    feeRate: 0.0005,
                    atrMultiplierSL: 1,
                    breakoutBuffer: 2,
                    simulationStartUnix: simStart,
                    type: 'backtest'
                }, subCandles);

                if ('trades' in result) {
                    trades = result.trades;
                    dailyPnl = trades.reduce((sum, t) => sum + t.profit, 0);
                    (res as any).indicators = (result as any).indicators || {};
                }
            }

            res.json({
                date,
                rangeHigh,
                rangeLow,
                rangeTime,
                tradesCount: trades.length,
                trades,
                dailyPnl,
                indicators: (res as any).indicators || {}
            });

        } catch (error: any) {
            console.error("Daily Analysis Error:", error);
            res.status(500).json({ error: error.message });
        }
    }
}
