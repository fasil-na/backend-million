import { type Request, type Response } from 'express';
import dayjs from 'dayjs';
import { strategies } from '../strategies/index.js';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import type { Candle, Trade } from '../types/index.js';

export class StrategyController {
    static getList(req: Request, res: Response) {
        const strategyList = Object.values(strategies).map(s => ({
            id: s.id,
            name: s.name,
            description: s.description
        }));
        res.json(strategyList);
    }

    static async runBacktest(req: Request, res: Response) {
        try {
            const {
                isLive, from, to, month, year, startYear, startMonth, endYear, endMonth,
                pair = "B-BTC_USDT", resolution = "5"
            } = req.body;

            let leverage = req.body.leverage || await CoinDCXApiService.getInstrumentLeverage(pair);
            let currentCapital = req.body.capital || req.body.capitalPerTrade || 1000;
            const initialCapital = currentCapital;
            let allTrades: Trade[] = [];
            let periods: { year: number, month: number }[] = [];

            if (isLive) {
                const todayStart = dayjs().tz('Asia/Kolkata').startOf('day');
                periods.push({ year: todayStart.year(), month: todayStart.month() });
            } else if (startYear !== undefined && startMonth !== undefined && endYear !== undefined && endMonth !== undefined) {
                let current = dayjs().year(startYear).month(startMonth).startOf('month');
                const end = dayjs().year(endYear).month(endMonth).endOf('month');
                while (current.isBefore(end)) {
                    periods.push({ year: current.year(), month: current.month() });
                    current = current.add(1, 'month');
                }
            } else if (year !== undefined && month !== undefined) {
                periods.push({ year, month });
            }

            for (const period of periods) {
                const monthStart = dayjs().year(period.year).month(period.month).startOf('month');
                const monthEnd = dayjs().year(period.year).month(period.month).endOf('month');

                let simStart = Math.floor(monthStart.valueOf() / 1000);
                let fetchStart = simStart - (24 * 60 * 60);
                let end = Math.floor(monthEnd.valueOf() / 1000);

                if (isLive) {
                    simStart = Math.floor(dayjs().tz('Asia/Kolkata').startOf('day').valueOf() / 1000);
                    fetchStart = simStart - (24 * 60 * 60);
                    end = Math.floor(Date.now() / 1000);
                }

                try {
                    const [resMain, resSub] = await Promise.all([
                        CoinDCXApiService.getCandlesticks({ pair, from: fetchStart, to: end, resolution }),
                        CoinDCXApiService.getCandlesticks({ pair, from: fetchStart, to: end, resolution: '1' }).catch(() => ({ s: 'error', data: [] }))
                    ]);

                    if (resMain.s === 'ok' && Array.isArray(resMain.data)) {
                        const candles = resMain.data.sort((a: Candle, b: Candle) => a.time - b.time);
                        const subCandles = Array.isArray(resSub.data) ? resSub.data.sort((a: Candle, b: Candle) => a.time - b.time) : [];

                        const strategy = strategies[req.body.strategyId || 'opening-breakout'] as any;
                        if (strategy) {
                            const result = strategy.run(candles, {
                                ...req.body, leverage, capital: currentCapital, simulationStartUnix: simStart, type: 'backtest'
                            }, subCandles);
                            
                            if ('trades' in result) {
                                allTrades.push(...result.trades);
                                currentCapital = result.finalBalance;
                                if (currentCapital <= 0) break;
                            }
                        }
                    }
                } catch (err) {
                    console.error('Backtest period error:', err);
                }
            }

            res.json({
                trades: allTrades,
                summary: {
                    totalProfit: allTrades.reduce((a, t) => a + t.profit, 0),
                    totalFee: allTrades.reduce((a, t) => a + (t.fee || 0), 0),
                    count: allTrades.length,
                    successCount: allTrades.filter(t => t.profit > 0).length,
                    failedCount: allTrades.filter(t => t.profit <= 0).length,
                    winRate: allTrades.length > 0 ? (allTrades.filter(t => t.profit > 0).length / allTrades.length) * 100 : 0,
                    initialCapital,
                    finalBalance: currentCapital
                }
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
