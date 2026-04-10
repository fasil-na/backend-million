import { type Request, type Response } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { PAPER_TRADES_FILE } from '../config/constants.js';

export class PaperTradeController {
    static record(req: Request, res: Response) {
        try {
            const { trade, pair } = req.body;
            if (!trade) return res.status(400).json({ error: 'Trade data required' });

            let trades = [];
            if (fs.existsSync(PAPER_TRADES_FILE)) {
                trades = JSON.parse(fs.readFileSync(PAPER_TRADES_FILE, 'utf-8'));
            }

            const newTrade = {
                ...trade,
                pair: pair || 'B-BTC_USDT',
                id: crypto.randomUUID(),
                recordedAt: new Date().toISOString()
            };

            trades.push(newTrade);
            fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(trades, null, 2));
            res.json({ success: true, trade: newTrade });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static list(req: Request, res: Response) {
        try {
            if (!fs.existsSync(PAPER_TRADES_FILE)) return res.json([]);
            res.json(JSON.parse(fs.readFileSync(PAPER_TRADES_FILE, 'utf-8')));
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
