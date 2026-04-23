import mongoose from 'mongoose';
import type { Trade } from '../types/index.js';

const trailingStepSchema = new mongoose.Schema({
    sl: Number,
    marketPrice: Number,
    time: String
}, { _id: false });

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
    initialSL: Number,
    tp: Number,
    stop_loss_price: Number,
    take_profit_price: Number,
    status: { type: String, enum: ['open', 'closed', 'failed'], required: true },
    profit: { type: Number, default: 0 },
    exitReason: String,
    lastHigh: Number,
    lastLow: Number,
    units: Number,
    fee: Number,
    trailingCount: Number,
    type: { type: String, enum: ['manual', 'auto', 'paper', 'real', 'recovery'], default: 'auto' },
    pair: String,
    executionError: String,
    trailingHistory: [trailingStepSchema]
}, {
    timestamps: true
});

export const TradeModel = mongoose.model<Trade & mongoose.Document>('Trade', tradeSchema);
