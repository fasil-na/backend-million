import { type Request, type Response } from 'express';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { TradeService } from '../services/TradeService.js';

export class TradeController {
    static async execute(req: Request, res: Response) {
        try {
            const apiKey = process.env.COINDCX_API_KEY;
            const apiSecret = process.env.COINDCX_API_SECRET;
            const { side, pair, price, capital = 100 } = req.body;

            if (!apiKey || !apiSecret) {
                return res.status(400).json({ error: 'Backend API Key and Secret are not configured' });
            }

            const marketDetails = await CoinDCXApiService.getMarketDetails(pair);
            if (!marketDetails) {
                return res.status(404).json({ error: `Market details not found for ${pair || 'DOGEINR'}` });
            }

            if (capital <= 0) {
                return res.status(400).json({ error: 'Insufficient capital (Bankruptcy)' });
            }

            const targetPrecision = marketDetails.target_currency_precision;
            const quantityNum = capital / parseFloat(price || "1");
            const quantity = quantityNum.toFixed(targetPrecision).toString();

            const result = await TradeService.executeOrder({
                apiKey,
                apiSecret,
                side,
                market: pair || 'DOGEINR',
                price,
                quantity
            });

            res.json(result);
        } catch (error: any) {
            console.error('Trade Execution Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    }

    static async getBalances(req: Request, res: Response) {
        try {
            const apiKey = process.env.COINDCX_API_KEY;
            const apiSecret = process.env.COINDCX_API_SECRET;

            if (!apiKey || !apiSecret) {
                return res.status(400).json({ error: 'Backend API Key and Secret are not configured' });
            }

            const balances = await TradeService.getBalances(apiKey, apiSecret);
            res.json(balances);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
}
