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

            console.log(price,'price------')

            if (capital <= 0) {
                return res.status(400).json({ error: 'Insufficient capital (Bankruptcy)' });
            }

            const settings = SettingsService.getSettings();
            const leverage = settings.leverage || 1;
            const activePair = pair || settings.pair;

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
                console.log(candleRes.data.length,'candleRes.data,------')
                let atr = calculateATR(candleRes.data, 14);
                const entryPrice = parseFloat(price || "0");
                
                // Fallback: If ATR is 0 or too small, use 1% of entry price as a minimum buffer
                if (atr === 0 || atr < (entryPrice * 0.001)) {
                    console.log(`[TradeController] ⚠️ ATR calculation returned ${atr}, using fallback 1% SL.`);
                    atr = entryPrice * 0.01;
                }
                
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - atr : entryPrice + atr;
                console.log(`[TradeController] 📊 SL Calculated: ${calculatedSL} (Entry: ${entryPrice}, ATR: ${atr}, Side: ${side})`);
            } else {
                console.log(`[TradeController] ⚠️ Failed to fetch candles for SL calculation, using fallback 1% SL.`);
                const entryPrice = parseFloat(price || "0");
                const fallbackAtr = entryPrice * 0.01;
                calculatedSL = side.toLowerCase() === 'buy' ? entryPrice - fallbackAtr : entryPrice + fallbackAtr;
            }

            const bankBalance = settings.bankBalance || 0;
            const effectiveCapital = settings.isLiveTrading ? bankBalance : capital;
            if(effectiveCapital <= 0){
                return res.status(400).json({ error: 'Insufficient capital (Bankruptcy)' });
            }

            const rawPair = pair || settings.pair;
            const parsedPrice = parseFloat(price || "1");
            const staticData = TradeService.STATIC_INSTRUMENTS[rawPair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
            const minNotional = staticData.minNotional || 6;
            const step = staticData.qtyStep;

            // Calculate quantity purely based on minimum notional requirement (e.g. $6), safely rounded up to the exchange's step size.
            const quantityNum = Math.ceil((minNotional / parsedPrice) / step) * step;
console.log(quantityNum,'quantityNum======')
            const formattedParams = TradeService.formatTradeParams(rawPair, quantityNum, leverage, 0, calculatedSL, side);
            console.log(formattedParams,'formattedParams----')
            let result: any = { message: 'Trade recorded in paper history (Real execution disabled)' };

            console.log(`[TradeController] 📝 Recording manual paper trade for ${rawPair}...`);
            // Record in paper trade history
            await PaperTradeService.saveTrade({
                entryTime: new Date().toISOString(),
                direction: side,
                pair: formattedParams.pair,
                entryPrice: Number(price),
                units: formattedParams.qty,
                sl: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                status: 'open',
                profit: 0,
                type: 'manual'
            });

            if (settings.isLiveTrading) {
                if (!apiKey || !apiSecret) {
                    return res.status(400).json({ error: 'Backend API Key and Secret are not configured for Live Trading' });
                }
                result = await TradeService.executeFutureOrder({
                    direction: side,
                    pair: formattedParams.pair,
                    entryPrice: Number(price),
                    units: formattedParams.qty,
                    stop_loss_price: formattedParams.slPrice > 0 ? formattedParams.slPrice : undefined,
                    leverage: formattedParams.maxLeverage
                });
            }

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
