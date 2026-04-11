import mongoose from 'mongoose';
import type { Trade } from '../types/index.js';

const tradeSchema = new mongoose.Schema({
    rangeHigh: Number,
    rangeLow: Number,
    breakoutTime: String,
    entryTime: { type: String, required: true, unique: true },
    exitTime: String,
    direction: { type: String, enum: ['buy', 'sell'], required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: Number,
    sl: Number,
    tp: Number,
    stop_loss_price: Number,
    take_profit_price: Number,
    status: { type: String, enum: ['open', 'closed'], required: true },
    profit: { type: Number, default: 0 },
    exitReason: String,
    lastHigh: Number,
    lastLow: Number,
    units: Number,
    fee: Number,
    trailingCount: Number,
    type: { type: String, enum: ['manual', 'auto'], default: 'auto' },
    pair: String
}, {
    timestamps: true
});

export const TradeModel = mongoose.model<Trade & mongoose.Document>('Trade', tradeSchema);
