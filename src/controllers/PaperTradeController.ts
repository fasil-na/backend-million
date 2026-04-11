import { type Request, type Response } from 'express';
import { PaperTradeService } from '../services/PaperTradeService.js';

export class PaperTradeController {
    static record(req: Request, res: Response) {
        try {
            const { trade } = req.body;
            if (!trade) return res.status(400).json({ error: 'Trade data required' });

            PaperTradeService.saveTrade(trade);
            res.json({ success: true, trade });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static list(req: Request, res: Response) {
        try {
            res.json(PaperTradeService.getTrades());
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static delete(req: Request, res: Response) {
        try {
            const { entryTime } = req.params;
            PaperTradeService.deleteTrade(entryTime as string);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static clear(req: Request, res: Response) {
        try {
            PaperTradeService.clearAll();
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
