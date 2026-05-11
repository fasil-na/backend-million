import { type Request, type Response } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { CoinDCXApiService } from '../services/CoinDCXApiService.js';
import { TradeService } from '../services/TradeService.js';
import { SettingsService } from '../services/SettingsService.js';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { calculateATR } from '../strategies/StrategyUtils.js';
import { PriceStore } from '../services/PriceStore.js';
import { SocketService } from '../services/SocketService.js';
import { LiveConfigService } from '../services/LiveConfigService.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export class TradeController {
    static async execute(req: Request, res: Response) {
        try {
            const { side, configId, pair: bodyPair, slPrice: manualSL, overrideQuantity } = req.body;
            
            if (!side || !configId) {
                return res.status(400).json({ error: 'Missing side or configId' });
            }

            const config = await LiveConfigService.getConfig(configId);
            if (!config) return res.status(404).json({ error: 'Configuration not found' });

            const pair = bodyPair || config.pair;
            
            const entryPrice = await PriceStore.getOrFetch(pair);
            if (!entryPrice || entryPrice <= 0) {
                return res.status(400).json({ error: 'Could not determine entry price.' });
            }

            // Handle existing trades for the same pair
            const existingTrade = await TradeHistoryService.getActiveTradeByPair(pair);
            if (existingTrade) {
                if (existingTrade.direction !== side.toLowerCase()) {
                    // Opposite side - CLOSE the existing trade
                    console.log(`[TradeController] 🔄 Opposite side detected. Closing existing ${existingTrade.direction} trade for ${pair}...`);
                    
                    try {
                        // 1. Get positions from exchange to find the ID
                        const positions = await TradeService.getPositions();
                        const exchangePos = Array.isArray(positions) ? positions.find((p: any) => p.pair === pair) : null;
                        
                        let closeResult;
                        if (exchangePos && (exchangePos.id || exchangePos.position_id)) {
                            const posId = exchangePos.id || exchangePos.position_id;
                            closeResult = await TradeService.closePosition({ positionId: posId });
                        }

                        // 2. Update trade history
                        await TradeHistoryService.saveTrade({
                            ...existingTrade,
                            status: 'closed',
                            exitPrice: entryPrice,
                            exitTime: dayjs().tz('Asia/Kolkata').format(),
                            exitReason: 'Manual Close'
                        });
                        
                        await SocketService.syncActiveTrade(configId);
                        return res.json({ 
                            message: 'Position closed successfully', 
                            closed: true,
                            result: closeResult 
                        });
                    } catch (err: any) {
                        console.error('Failed to close position:', err.message);
                        return res.status(500).json({ error: 'Failed to close existing position', details: err.message });
                    }
                } else {
                    return res.status(400).json({ error: `A ${existingTrade.direction} trade is already open for ${pair}.` });
                }
            }

            const leverage = config.leverage || 10;

            const details = await TradeService.getInstrumentDetails(pair);
            const step = details.quantity_increment || 0.001;

            let quantityNum = 0;
            if (overrideQuantity) {
                quantityNum = overrideQuantity;
            } else {
                if (config.riskMode === 'minimal') {
                    // For minimal risk, we just set a tiny quantity.
                    // TradeService.formatTradeParams will automatically bump it up to the exchange's minimum notional (e.g. $6.5)
                    quantityNum = step; 
                } else {
                    const capital = config.initialCapital || 100;
                    quantityNum = Math.floor(((capital * leverage) / entryPrice) / step) * step;
                }
            }

            const sl = manualSL || (side === 'buy' ? entryPrice * 0.95 : entryPrice * 1.05);

            const formattedParams = TradeService.formatTradeParams(pair, quantityNum, leverage, 0, sl, side, entryPrice);
         
            try {
                const result = await executeWithRetry(() =>
                    TradeService.executeFutureOrder({
                        direction: side.toLowerCase(),
                        pair: formattedParams.pair,
                        entryPrice: entryPrice,
                        units: formattedParams.qty,
                        stop_loss_price: formattedParams.slPrice,
                        leverage: formattedParams.maxLeverage
                    })
                );

                await TradeHistoryService.saveTrade({
                    entryTime: dayjs().tz('Asia/Kolkata').format(),
                    direction: side,
                    pair: formattedParams.pair,
                    configId,
                    strategyId: config.strategyId || 'manual',
                    entryPrice: entryPrice,
                    units: formattedParams.qty,
                    sl: formattedParams.slPrice,
                    status: 'open',
                    profit: 0,
                    type: 'manual'
                });

                await SocketService.syncActiveTrade(configId);
                return res.json(result);
            } catch (err: any) {
                const errorMessage = err.response?.data?.message || err.message;
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