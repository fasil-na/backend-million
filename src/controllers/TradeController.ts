import { type Request, type Response } from 'express';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { TradeService } from '../services/TradeService.js';
import { SettingsService } from '../services/SettingsService.js';
import { PaperTradeService } from '../services/PaperTradeService.js';
import { calculateATR } from '../strategies/StrategyUtils.js';

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

            const settings = SettingsService.getSettings();
            const leverage = settings.leverage || 1;

            // Fetch recent candles for ATR-based SL calculation
            const now = Math.floor(Date.now() / 1000);
            const candleRes = await CoinDCXApiService.getCandlesticks({
                pair: pair || settings.pair,
                resolution: '1',
                from: now - 86400, // last 24 hours
                to: now
            });

            let calculatedSL = 0;
            if (candleRes && candleRes.s === 'ok' && Array.isArray(candleRes.data)) {
                const atr = calculateATR(candleRes.data, 14);
                const entryPrice = parseFloat(price || "0");
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - atr : entryPrice + atr;
            }

            const targetPrecision = marketDetails.target_currency_precision;
            const quantityNum = (capital * leverage) / parseFloat(price || "1");
            const quantity = quantityNum.toFixed(targetPrecision).toString();

            let result: any = { message: 'Trade recorded in paper history (Real execution disabled)' };
            
   
            // Record in paper trade history
            await PaperTradeService.saveTrade({
                entryTime: new Date().toISOString(),
                direction: side,
                pair: pair || settings.pair,
                entryPrice: Number(price),
                units: Number(quantity),
                sl: calculatedSL > 0 ? calculatedSL : undefined,
                status: 'open',
                profit: 0,
                type: 'manual'
            });

                     if (settings.isLiveTrading) {
                result = await TradeService.executeFutureOrder({
                    direction: side,
                    pair: pair || settings.pair,
                    entryPrice: Number(price),
                    units: Number(quantity),
                    stop_loss_price: calculatedSL > 0 ? calculatedSL : undefined
                });
            }
            
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

            const balances = await TradeService.getBalances();
            res.json(balances);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
}
