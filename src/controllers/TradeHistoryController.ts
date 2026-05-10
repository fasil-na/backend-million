import { type Request, type Response } from 'express';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { SocketService } from '../services/SocketService.js';
import { SettingsService } from '../services/SettingsService.js';

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
            
            // 🛡️ Sync Memory: Remove from bot tracking if it was an active trade
            SocketService.clearActiveTradeByTime(entryTime as string);
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async clear(req: Request, res: Response) {
        try {
            await TradeHistoryService.clearAll();
            
            // 🛡️ Sync Memory: Stop tracking all currently active trades
            SocketService.clearAllActiveTrades();
            
            // Notify all clients that history has been reset
            SocketService.getIO().emit('trade-history-update', null);
            
            // 🔄 Auto-Recovery: Re-populate current day's trades from 00:00 as 'recovery'
            await SocketService.syncExchangeState();
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
