import { type Request, type Response } from 'express';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { TradeService } from '../services/TradeService.js';
import { SettingsService } from '../services/SettingsService.js';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { calculateATR, formatPair } from '../strategies/StrategyUtils.js';
import { PriceStore } from '../services/PriceStore.js';
import { LiveConfigService } from '../services/LiveConfigService.js';

export class TradeController {
    static async execute(req: Request, res: Response) {
        try {
            const apiKey = process.env.COINDCX_API_KEY;
            const apiSecret = process.env.COINDCX_API_SECRET;

            if (!apiKey || !apiSecret) {
                return res.status(400).json({ error: 'Backend API Key and Secret are not configured for Live Trading' });
            }

            const { side, pair: bodyPair } = req.body;
            if (!side || !['buy', 'sell'].includes(side.toLowerCase())) {
                return res.status(400).json({ error: 'Invalid side. Must be "buy" or "sell".' });
            }

            const settings = SettingsService.getSettings();

            if (!settings.isLiveTrading) {
                return res.status(400).json({ error: 'Global Live Trading toggle is OFF. Manual trades blocked.' });
            }

            // 🎯 NEW: Look up configuration for this pair (Normalized to B-XXXX_USDT)
            const activePair = formatPair(bodyPair || 'B-BTC_USDT');
            const pairConfig = await LiveConfigService.getConfigByPair(activePair);
            
            if (!pairConfig) {
                return res.status(400).json({ error: `No configuration found for pair: ${activePair}. Please create one in Live Configurations.` });
            }

            const leverage = pairConfig.leverage || 1;
            const entryPrice = await PriceStore.getOrFetch(activePair);

            if (!entryPrice || entryPrice <= 0) {
                return res.status(400).json({ error: 'Could not determine entry price.' });
            }

            // Fetch recent candles for ATR-based SL calculation
            const now = Math.floor(Date.now() / 1000);
            const candleRes = await CoinDCXApiService.getCandlesticks({
                pair: activePair,
                resolution: '1',
                from: now - 86400, // last 24 hours
                to: now
            });

            let calculatedSL = 0;
            if (candleRes && candleRes.s === 'ok' && Array.isArray(candleRes.data)) {
                let atr = calculateATR(candleRes.data, 14);
                if (atr === 0 || atr < (entryPrice * 0.001)) atr = entryPrice * 0.01;
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - atr : entryPrice + atr;
            } else {
                const fallbackAtr = entryPrice * 0.01;
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - fallbackAtr : entryPrice + fallbackAtr;
            }
            
            const riskAmount = Math.abs(entryPrice - calculatedSL);
            const calculatedTP = side.toLowerCase() === 'buy' 
                ? entryPrice + (riskAmount * 1.9) 
                : entryPrice - (riskAmount * 1.9);

            const exchangeData = await TradeService.getInstrumentDetails(activePair);
            const minNotional = exchangeData.minNotional || 6;
            const step = exchangeData.qtyStep || 0.001;

            // 🎯 RISK CALCULATION using pair config:
            let quantityNum = 0;
            if (pairConfig.riskMode === 'capital') {
                const capitalToUse = pairConfig.initialCapital || 100;
                quantityNum = Math.floor(((capitalToUse * leverage) / entryPrice) / step) * step;
                const minQty = Math.ceil((minNotional / entryPrice) / step) * step;
                if (quantityNum < minQty) quantityNum = minQty;
            } else {
                quantityNum = Math.ceil((minNotional / entryPrice) / step) * step;
            }

            const formattedParams = await TradeService.formatTradeParams(activePair, quantityNum, leverage, calculatedTP, calculatedSL, side, entryPrice);
         
            try {
                const result = await executeWithRetry(() =>
                    TradeService.executeFutureOrder({
                        direction: side.toLowerCase(),
                        pair: formattedParams.pair,
                        entryPrice: entryPrice,
                        units: formattedParams.qty,
                        stop_loss_price: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                        take_profit_price: formattedParams.tpPrice > 0 ? formattedParams.tpPrice : undefined,
                        leverage: formattedParams.maxLeverage
                    })
                );

                await TradeHistoryService.saveTrade({
                    entryTime: new Date().toISOString(),
                    direction: side,
                    pair: formattedParams.pair,
                    entryPrice: entryPrice,
                    units: formattedParams.qty,
                    sl: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                    tp: formattedParams.tpPrice > 0 ? formattedParams.tpPrice : undefined,
                    status: 'open',
                    profit: 0,
                    type: 'real',
                    configId: pairConfig._id?.toString()
                });
                return res.json(result);
            } catch (err: any) {
                const errorMessage = err.response?.data?.message || err.message;
                await TradeHistoryService.saveTrade({
                    entryTime: new Date().toISOString(),
                    direction: side,
                    pair: formattedParams.pair,
                    entryPrice: entryPrice,
                    units: formattedParams.qty,
                    sl: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                    tp: formattedParams.tpPrice > 0 ? formattedParams.tpPrice : undefined,
                    status: 'failed',
                    profit: 0,
                    type: 'real',
                    executionError: errorMessage
                });

                return res.status(400).json({ error: 'Exchange Execution Failed', details: errorMessage });
            }
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
                return res.status(400).json({ error: 'Backend API Key and Secret are not configured for Exchange API access' });
            }

            const balances = await TradeService.getBalances();
            res.json(balances);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
    
}
async function executeWithRetry(fn:any, retries = 3) {
    let lastError;

    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            console.warn(`Retry ${i + 1} failed`);
        }
    }

    throw lastError;
}