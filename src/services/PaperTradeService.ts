import fs from 'fs';
import { PAPER_TRADES_FILE } from '../config/constants.js';
import type { Trade } from '../types/index.js';

export class PaperTradeService {
    private static ensureFile() {
        if (!fs.existsSync(PAPER_TRADES_FILE)) {
            fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify([], null, 2));
        }
    }

    static getTrades(): Trade[] {
        this.ensureFile();
        try {
            const data = fs.readFileSync(PAPER_TRADES_FILE, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            console.error("Error reading paper trades:", e);
            return [];
        }
    }

    static saveTrade(trade: Trade) {
        const trades = this.getTrades();
        const index = trades.findIndex(t => t.entryTime === trade.entryTime);
        
        if (index !== -1) {
            trades[index] = trade;
        } else {
            trades.push(trade);
        }
        
        fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(trades, null, 2));
    }

    static updateTrade(trade: Trade) {
        const trades = this.getTrades();
        const index = trades.findIndex(t => t.entryTime === trade.entryTime);
        if (index !== -1) {
            trades[index] = trade;
            fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(trades, null, 2));
        }
    }

    static getActiveTrade(): Trade | null {
        return this.getTrades().find(t => t.status === 'open') || null;
    }

    static deleteTrade(entryTime: string) {
        const trades = this.getTrades();
        const filtered = trades.filter(t => t.entryTime !== entryTime);
        fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(filtered, null, 2));
    }

    static clearAll() {
        fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify([], null, 2));
    }
}
