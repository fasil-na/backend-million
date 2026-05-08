import { type Request, type Response } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { strategies } from '../strategies/index.js';
import type { Candle } from '../types/index.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export class FVGAnalysisController {
    static async getDailyAnalysis(req: Request, res: Response) {
        try {
            const { date, pair = "B-XAU_USDT" } = req.query;
            if (!date) return res.status(400).json({ error: "Date parameter is required (YYYY-MM-DD)" });

            const targetDay = dayjs.tz(date as string, 'Asia/Kolkata');
            const simStart = Math.floor(targetDay.startOf('day').valueOf() / 1000);
            const simEnd = Math.floor(targetDay.endOf('day').valueOf() / 1000);
            
            // Match Backtest warmup (7 days) for indicator stability (EMA200 etc)
            const fetchStart = simStart - (7 * 24 * 60 * 60);
            
            const [resMain] = await Promise.all([
                CoinDCXApiService.getCandlesticks({ pair, from: fetchStart, to: simEnd, resolution: '5' })
            ]);

            if (resMain.s === 'no_data' || !Array.isArray(resMain.data)) {
                return res.json({
                    date,
                    tradesCount: 0,
                    trades: [],
                    dailyPnl: 0,
                    indicators: {}
                });
            }

            const candles = resMain.data.sort((a: Candle, b: Candle) => a.time - b.time);

            // Run FVG Strategy
            const strategy = strategies['fvg-imbalance'] as any;
            let trades: any[] = [];
            let dailyPnl = 0;
            let indicators = {};

            if (strategy) {
                const result = strategy.run(candles, {
                    capital: Number(req.query.capital) || 1000,
                    riskRewardRatio: Number(req.query.rr) || undefined,
                    riskAmount: Number(req.query.riskAmount) || undefined,
                    simulationStartUnix: simStart,
                    type: 'backtest'
                });

                if ('trades' in result) {
                    // Filter trades to only those that ENTERED on the target day
                    trades = result.trades.filter((t: any) => {
                        const entryUnix = Math.floor(new Date(t.entryTime).getTime() / 1000);
                        return entryUnix >= simStart && entryUnix <= simEnd;
                    });
                    
                    dailyPnl = trades.reduce((sum, t) => sum + (t.profit || 0), 0);
                    indicators = result.indicators || {};
                }
            }

            res.json({
                date,
                tradesCount: trades.length,
                trades,
                dailyPnl,
                indicators,
                candles: candles.filter((c: any) => (c.time / 1000) >= simStart && (c.time / 1000) <= simEnd)
            });

        } catch (error: any) {
            console.error("FVG Analysis Error:", error);
            res.status(500).json({ error: error.message });
        }
    }
}
