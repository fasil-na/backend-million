import { type Request, type Response } from 'express';
import { PaperTradeService } from '../services/PaperTradeService.js';

export class PaperTradeController {
    static async record(req: Request, res: Response) {
        try {
            console.log('hiting-------')
            const { trade } = req.body;
            if (!trade) return res.status(400).json({ error: 'Trade data required' });

            await PaperTradeService.saveTrade(trade);
            return res.json({ success: true, trade });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async list(req: Request, res: Response) {
        try {
            const trades = await PaperTradeService.getTrades();
            res.json(trades);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async delete(req: Request, res: Response) {
        try {
            const { entryTime } = req.params;
            await PaperTradeService.deleteTrade(entryTime as string);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async clear(req: Request, res: Response) {
        try {
            await PaperTradeService.clearAll();
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
