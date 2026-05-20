import { type Request, type Response } from 'express';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { SocketService } from '../services/SocketService.js';
import { TradeService } from '../services/TradeService.js';

export class TradeHistoryController {
    static async list(req: Request, res: Response) {
        try {
            const trades = await TradeHistoryService.getTrades();
            res.json(trades);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async delete(req: Request, res: Response) {
        try {
            const { entryTime } = req.params;
            await TradeHistoryService.deleteTrade(entryTime as string);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async clear(req: Request, res: Response) {
        try {
            await TradeHistoryService.clearAll();
            
            // 🔄 Auto-Recovery: Re-populate current day's trades from 00:00
            await SocketService.recoverTodayTrades();

            // 🆕 Sync Open Positions from Exchange
            try {
                const positions = await TradeService.getPositions();
                if (Array.isArray(positions)) {
                    for (const pos of positions) {
                        if (pos && pos.active_pos !== 0) {
                            const pair = pos.pair;
                            const activeTrade = await TradeHistoryService.getActiveTradeByPair(pair);
                            
                            if (!activeTrade) {
                                const newTrade = {
                                    pair,
                                    entryPrice: pos.avg_price,
                                    units: Math.abs(pos.active_pos),
                                    sl: pos.stop_loss_trigger || 0,
                                    tp: pos.take_profit_trigger || 0,
                                    direction: pos.active_pos > 0 ? 'buy' : 'sell',
                                    status: 'open',
                                    type: 'real',
                                    entryTime: new Date().toISOString(),
                                };
                                await TradeHistoryService.saveTrade(newTrade as any);
                            }
                        }
                    }
                }
            } catch (exchangeErr) {
                console.error("Failed to sync exchange positions during clear:", exchangeErr);
            }
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
