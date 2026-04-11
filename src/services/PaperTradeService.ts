import mongoose from 'mongoose';
import fs from 'fs';
import { PAPER_TRADES_FILE } from '../config/constants.js';
import type { Trade } from '../types/index.js';
import { TradeModel } from '../models/Trade.js';

export class PaperTradeService {
    private static migrated = false;

    private static async migrateIfNeeded() {
        if (this.migrated) return;
        try {
            if (fs.existsSync(PAPER_TRADES_FILE)) {
                const data = fs.readFileSync(PAPER_TRADES_FILE, 'utf8');
                const trades: Trade[] = JSON.parse(data);
                if (trades.length > 0) {
                    console.log(`[Migration] Found ${trades.length} trades in JSON. Migrating to MongoDB...`);
                    for (const trade of trades) {
                        await TradeModel.findOneAndUpdate(
                            { entryTime: trade.entryTime },
                            trade,
                            { upsert: true }
                        );
                    }
                    console.log(`[Migration] Successfully migrated trades to MongoDB.`);
                    // Optionally rename or delete the file
                    fs.renameSync(PAPER_TRADES_FILE, `${PAPER_TRADES_FILE}.bak`);
                }
            }
        } catch (e) {
            console.error("[Migration] Error migrating paper trades:", e);
        }
        this.migrated = true;
    }

    static async getTrades(): Promise<Trade[]> {
        if (mongoose.connection.readyState !== 1) {
            console.error("MongoDB not connected. Cannot get trades.");
            return [];
        }
        await this.migrateIfNeeded();
        try {
            return await TradeModel.find().sort({ entryTime: -1 }).lean();
        } catch (e) {
            console.error("Error reading paper trades from MongoDB:", e);
            return [];
        }
    }

    static async saveTrade(trade: Trade) {
        await this.migrateIfNeeded();
        try {
            await TradeModel.findOneAndUpdate(
                { entryTime: trade.entryTime },
                trade,
                { upsert: true, new: true }
            );
        } catch (e) {
            console.error("Error saving paper trade to MongoDB:", e);
        }
    }

    static async updateTrade(trade: Trade) {
        await this.saveTrade(trade);
    }

    static async getActiveTrade(): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        await this.migrateIfNeeded();
        try {
            const trade = await TradeModel.findOne({ status: 'open' }).lean();
            return trade as Trade | null;
        } catch (e) {
            console.error("Error getting active trade from MongoDB:", e);
            return null;
        }
    }

    static async deleteTrade(entryTime: string) {
        try {
            await TradeModel.deleteOne({ entryTime });
        } catch (e) {
            console.error("Error deleting paper trade from MongoDB:", e);
        }
    }

    static async clearAll() {
        try {
            await TradeModel.deleteMany({});
        } catch (e) {
            console.error("Error clearing paper trades from MongoDB:", e);
        }
    }
}
