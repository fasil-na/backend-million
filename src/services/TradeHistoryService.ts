import mongoose from 'mongoose';
import type { Trade } from '../types/index.js';
import { TradeModel } from '../models/Trade.js';

export class TradeHistoryService {
    static async getTrades(): Promise<Trade[]> {
        if (mongoose.connection.readyState !== 1) {
            console.error("MongoDB not connected. Cannot get trades.");
            return [];
        }
        try {
            return await TradeModel.find().sort({ entryTime: -1 }).lean();
        } catch (e) {
            console.error("Error reading trades from MongoDB:", e);
            return [];
        }
    }

    static async saveTrade(trade: Partial<Trade>) {
        if (mongoose.connection.readyState !== 1) {
            console.error("❌ MongoDB not connected. Cannot save trade.");
            throw new Error("Database connection error");
        }
        try {
            // Strip _id and __v to prevent Mongoose from throwing immutable field errors
            const { _id, __v, ...updateData } = trade as any;

            if (!trade.entryTime) {
              updateData.entryTime = new Date().toISOString();
            }

            const result = await TradeModel.findOneAndUpdate(
                { entryTime: updateData.entryTime },
                updateData,
                { upsert: true, returnDocument: 'after' }
            );
            console.log(`✅ Trade history saved [${trade.direction}] ${trade.pair} at ${trade.entryPrice}`);
            return result;
        } catch (e: any) {
            console.error("❌ Error saving trade to MongoDB:", e.message);
            throw e;
        }
    }

    static async updateTrade(trade: Partial<Trade>) {
        await this.saveTrade(trade);
    }

    static async getActiveTrade(): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        try {
            const trade = await TradeModel.findOne({ status: 'open' }).sort({ entryTime: -1 }).lean();
            return trade as Trade | null;
        } catch (e) {
            console.error("Error getting active trade from MongoDB:", e);
            return null;
        }
    }

    /**
     * Checks if a trade already exists within a 5-minute window of the given time.
     * Prevents duplicate logs when real trades and recovery logic overlap.
     */
    static async findOverlap(pair: string, entryTime: string): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        try {
            const windowMs = 3 * 60 * 1000; // 3 minute window
            const targetTime = new Date(entryTime).getTime();
            const start = new Date(targetTime - windowMs).toISOString();
            const end = new Date(targetTime + windowMs).toISOString();

            return await TradeModel.findOne({
                pair,
                entryTime: { $gte: start, $lte: end },
                type: { $in: ['real', 'paper'] }
            }).lean() as Trade | null;
        } catch (e) {
            return null;
        }
    }

    static async deleteTrade(entryTime: string) {
        try {
            await TradeModel.deleteOne({ entryTime });
        } catch (e) {
            console.error("Error deleting trade from MongoDB:", e);
        }
    }

    static async clearAll() {
        try {
            await TradeModel.deleteMany({
                $or: [
                    { status: { $ne: 'open' } },
                    { type: { $nin: ['real', 'paper'] } }
                ]
            });
        } catch (e) {
            console.error("Error clearing trades from MongoDB:", e);
        }
    }
}
