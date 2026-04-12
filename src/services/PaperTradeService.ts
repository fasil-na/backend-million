import mongoose from 'mongoose';
import type { Trade } from '../types/index.js';
import { TradeModel } from '../models/Trade.js';

export class PaperTradeService {
    static async getTrades(): Promise<Trade[]> {
        if (mongoose.connection.readyState !== 1) {
            console.error("MongoDB not connected. Cannot get trades.");
            return [];
        }
        try {
            return await TradeModel.find().sort({ entryTime: -1 }).lean();
        } catch (e) {
            console.error("Error reading paper trades from MongoDB:", e);
            return [];
        }
    }

    static async saveTrade(trade: Trade) {
        if (mongoose.connection.readyState !== 1) {
            console.error("❌ MongoDB not connected. Cannot save paper trade.");
            throw new Error("Database connection error");
        }
        try {
            // Strip _id and __v to prevent Mongoose from throwing immutable field errors
            const { _id, __v, ...updateData } = trade as any;

            const result = await TradeModel.findOneAndUpdate(
                { entryTime: trade.entryTime },
                updateData,
                { upsert: true, new: true }
            );
            console.log(`✅ Paper trade saved [${trade.direction}] ${trade.pair} at ${trade.entryPrice}`);
            return result;
        } catch (e: any) {
            console.error("❌ Error saving paper trade to MongoDB:", e.message);
            throw e;
        }
    }

    static async updateTrade(trade: Trade) {
        await this.saveTrade(trade);
    }

    static async getActiveTrade(): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
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
