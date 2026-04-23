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
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async clear(req: Request, res: Response) {
        try {
            await TradeHistoryService.clearAll();
            
            // 🔄 Reset internal status to closed
            const updatedSettings = await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
            
            // Notify all clients that settings and history have been reset
            SocketService.getIO().emit('settings-update', updatedSettings);
            SocketService.getIO().emit('trade-history-update', null);
            
            // 🔄 Auto-Recovery: Re-populate current day's trades from 00:00
            await SocketService.recoverTodayTrades();
            
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
