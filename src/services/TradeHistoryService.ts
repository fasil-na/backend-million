import mongoose from 'mongoose';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { Trade } from '../types/index.js';
import { TradeModel } from '../models/Trade.js';

dayjs.extend(utc);
dayjs.extend(timezone);

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
            // Ensure we are working with a plain object
            const tradeObj = (trade as any).toObject ? (trade as any).toObject() : { ...trade };
            const { _id, __v, ...updateData } = tradeObj;

            if (!updateData.entryTime) {
                updateData.entryTime = dayjs().tz('Asia/Kolkata').format();
            }

            // If we have an _id, we should update by that. Otherwise, use entryTime as unique key.
            const filter = _id ? { _id } : { entryTime: updateData.entryTime };

            const result = await TradeModel.findOneAndUpdate(
                filter,
                { $set: updateData },
                { upsert: true, returnDocument: 'after' }
            );

            console.log(`✅ Trade history saved [${updateData.direction}] ${updateData.pair} at ${updateData.entryPrice}`);
            return result;
        } catch (e: any) {
            console.error("❌ Error saving trade to MongoDB:", e.message);
            throw e;
        }
    }

    static async updateTrade(trade: Partial<Trade>) {
        await this.saveTrade(trade);
    }

    static async getActiveTrade(configId?: string): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        try {
            const query: any = { status: 'open' };
            if (configId) query.configId = configId;
            const trade = await TradeModel.findOne(query).sort({ entryTime: -1 }).lean();
            return trade as Trade | null;
        } catch (e) {
            console.error("Error getting active trade from MongoDB:", e);
            return null;
        }
    }

    static async getActiveTradeByPair(pair: string): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        try {
            const trade = await TradeModel.findOne({ pair, status: 'open' }).sort({ entryTime: -1 }).lean();
            return trade as Trade | null;
        } catch (e) {
            console.error("Error getting active trade by pair from MongoDB:", e);
            return null;
        }
    }

    static async findTradeByTime(entryTime: string): Promise<Trade | null> {
        if (mongoose.connection.readyState !== 1) return null;
        return await TradeModel.findOne({ entryTime }).lean() as Trade | null;
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
            const start = dayjs(targetTime - windowMs).tz('Asia/Kolkata').format();
            const end = dayjs(targetTime + windowMs).tz('Asia/Kolkata').format();

            return await TradeModel.findOne({
                pair,
                entryTime: { $gte: start, $lte: end }
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
                type: { $ne: 'real' },
                status: { $ne: 'open' }
            });
        } catch (e) {
            console.error("Error clearing trades from MongoDB:", e);
        }
    }
}
