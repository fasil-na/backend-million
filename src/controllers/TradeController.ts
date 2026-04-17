import { type Request, type Response } from 'express';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { TradeService } from '../services/TradeService.js';
import { SettingsService } from '../services/SettingsService.js';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { calculateATR } from '../strategies/StrategyUtils.js';
import { PriceStore } from '../services/PriceStore.js';

export class TradeController {
    static async execute(req: Request, res: Response) {
        try 
{
            const apiKey = process.env.COINDCX_API_KEY;
            const apiSecret = process.env.COINDCX_API_SECRET;

               if (!apiKey || !apiSecret) {
                return res.status(400).json({ error: 'Backend API Key and Secret are not configured for Live Trading' });
            }
            const { side, pair, price } = req.body;
if (!side || !['buy', 'sell'].includes(side.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid side' });
}
const balances = await TradeService.getBalances();
// Find USDT balance (or your margin currency)
const usdtBalance = balances.find(
  (b: any) => b.currency === 'USDT' || b.currency_short_name === 'USDT'
);

const availableBalance = Number(usdtBalance?.balance || 0);
if (availableBalance <= 0) {
    return res.status(400).json({ error: 'Insufficient balance in account' });
}

            const settings = SettingsService.getSettings();


 if (!settings.isLiveTrading) {
                return res.status(400).json({ error: 'Live trading is disabled. Manual trades can only be executed in live mode.' });
            }


            const leverage = settings.leverage || 1;
            const activePair = pair || settings.pair;
            const entryPrice = PriceStore.get(activePair) || 0;

            if (entryPrice <= 0) {
                return res.status(400).json({ error: 'Could not determine entry price. Please wait for market data or provide a manual price.' });
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
                // Fallback: If ATR is 0 or too small, use 1% of entry price as a minimum buffer
                if (atr === 0 || atr < (entryPrice * 0.001)) {
                    atr = entryPrice * 0.01;
                }
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - atr : entryPrice + atr;
            } else {
                const fallbackAtr = entryPrice * 0.01;
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - fallbackAtr : entryPrice + fallbackAtr;
            }


          
            const bankBalance = availableBalance || 0;
            const effectiveCapital = settings.isLiveTrading ? bankBalance : 0;
            if (effectiveCapital <= 0) {
                return res.status(400).json({ error: 'Insufficient capital (Bankruptcy)' });
            }

            const rawPair = activePair;
            const parsedPrice = entryPrice;
            const staticData = TradeService.STATIC_INSTRUMENTS[rawPair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
            const minNotional = staticData.minNotional || 6;
            const step = staticData.qtyStep;

            // Calculate quantity purely based on minimum notional requirement (e.g. $6), safely rounded up to the exchange's step size.
            const quantityNum = Math.ceil((minNotional / parsedPrice) / step) * step;
            const formattedParams = TradeService.formatTradeParams(rawPair, quantityNum, leverage, 0, calculatedSL, side);
         

              // ======================-------------========================-------------
         

            
const result = await executeWithRetry(() =>
     TradeService.executeFutureOrder({
                direction: side.toLowerCase(),
                pair: formattedParams.pair,
                entryPrice: entryPrice,
                units: formattedParams.qty,
                stop_loss_price: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                leverage: formattedParams.maxLeverage
            })
);

            // Record in trade history
            await TradeHistoryService.saveTrade({
                entryTime: new Date().toISOString(),
                direction: side,
                pair: formattedParams.pair,
                entryPrice: entryPrice,
                units: formattedParams.qty,
                sl: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                status: 'open',
                profit: 0,
                type: 'manual'
            });

            return res.json(result);
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