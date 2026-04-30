import { type Request, type Response } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
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
            console.log('calling bactest route---')
            const {
                isLive, from, to, month, year, startYear, startMonth, endYear, endMonth,
                pair = "B-BTC_USDT", resolution = "5", timezone = "UTC"
            } = req.body;

            let leverage = req.body.leverage || await CoinDCXApiService.getInstrumentLeverage(pair);
            let currentCapital = req.body.capital || req.body.capitalPerTrade || 1000;
            const initialCapital = currentCapital;
            let allTrades: Trade[] = [];
            let periods: { start: dayjs.Dayjs, end: dayjs.Dayjs }[] = [];

            if (isLive) {
                const todayStart = timezone === 'IST' ? dayjs().tz('Asia/Kolkata').startOf('day') : dayjs().utc().startOf('day');
                periods.push({ start: todayStart, end: timezone === 'IST' ? dayjs().tz('Asia/Kolkata') : dayjs().utc() });
            } else if (req.body.startDate && req.body.endDate) {
                let start = timezone === 'IST' ? dayjs.tz(req.body.startDate, 'Asia/Kolkata').startOf('day') : dayjs.utc(req.body.startDate).startOf('day');
                let finalEnd = timezone === 'IST' ? dayjs.tz(req.body.endDate, 'Asia/Kolkata').endOf('day') : dayjs.utc(req.body.endDate).endOf('day');

                let current = start;
                while (current.isBefore(finalEnd)) {
                    let nextMonth = current.add(1, 'month').startOf('month');
                    let periodEnd = nextMonth.isAfter(finalEnd) ? finalEnd : nextMonth.subtract(1, 'second');
                    periods.push({ start: current, end: periodEnd });
                    current = nextMonth;
                }
            } else if (startYear !== undefined && startMonth !== undefined && endYear !== undefined && endMonth !== undefined) {
                let current = dayjs().year(startYear).month(startMonth).startOf('month');
                const end = dayjs().year(endYear).month(endMonth).endOf('month');
                while (current.isBefore(end)) {
                    periods.push({ start: current.startOf('month'), end: current.endOf('month') });
                    current = current.add(1, 'month');
                }
            } else if (year !== undefined && month !== undefined) {
                const start = dayjs().year(year).month(month).startOf('month');
                periods.push({ start, end: start.endOf('month') });
            }

            for (const period of periods) {
                let simStart = Math.floor(period.start.valueOf() / 1000);
                let end = Math.floor(period.end.valueOf() / 1000);
                let fetchStart = simStart - (7 * 24 * 60 * 60);

                console.log(`[Controller] 📅 Backtest Period: ${period.start.format('YYYY-MM-DD HH:mm:ss Z')} to ${period.end.format('YYYY-MM-DD HH:mm:ss Z')}`);
                console.log(`[Controller] 🕒 simStart: ${simStart} (${dayjs.unix(simStart).utc().format('YYYY-MM-DD HH:mm:ss')} UTC)`);

                if (isLive) {
                    simStart = Math.floor((timezone === 'IST' ? dayjs().tz('Asia/Kolkata').startOf('day') : dayjs().utc().startOf('day')).valueOf() / 1000);
                    fetchStart = simStart - (7 * 24 * 60 * 60);
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
                                ...req.body,
                                leverage,
                                atrMultiplierSL: 1,
                                capital: currentCapital,
                                simulationStartUnix: simStart,
                                type: 'backtest'
                            }, subCandles);

                            if ('trades' in result) {
                                allTrades.push(...result.trades);

                                // Show currently open simulated trades in the UI so users 
                                // don't think recent signals were missed if they haven't closed yet.
                                // if (result.activeTrade) {
                                //     allTrades.push(result.activeTrade);
                                // }

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
