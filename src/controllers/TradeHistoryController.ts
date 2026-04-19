import { type Request, type Response } from 'express';
import { TradeHistoryService } from '../services/TradeHistoryService.js';
import { SocketService } from '../services/SocketService.js';

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
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
