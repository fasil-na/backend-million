import { type Request, type Response } from 'express';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import dummyData from '../data/dummy_15m.json' with { type: 'json' };
import { strategies } from '../strategies/index.js';

export class MarketController {
    static async getCandlesticks(req: Request, res: Response) {
        try {
            const { pair = 'B-BTC_USDT', resolution = '60', from, to, useDummy } = req.query;

            if (useDummy === 'true') {
                return res.json(dummyData);
            }

            const now = Math.floor(Date.now() / 1000);
            const yesterday = now - (24 * 60 * 60);

            let fromNum = Number(from || yesterday);
            let toNum = Number(to || now);

            if (fromNum > toNum) {
                const temp = fromNum;
                fromNum = toNum;
                toNum = temp;
            }

            const data = await CoinDCXApiService.getCandlesticks({
                pair,
                from: fromNum,
                to: toNum,
                resolution: String(resolution)
            });

            res.json(data);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    static async getLeverage(req: Request, res: Response) {
        try {
            const { pair } = req.params;
            const leverage = await CoinDCXApiService.getInstrumentLeverage(pair as string);
            res.json({ leverage });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    static getStrategies(req: Request, res: Response) {
        const strategyList = Object.values(strategies).map(s => ({
            id: s.id,
            name: s.name,
            description: s.description
        }));
        res.json(strategyList);
    }
}
