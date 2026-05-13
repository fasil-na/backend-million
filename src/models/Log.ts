import mongoose from 'mongoose';

const logSchema = new mongoose.Schema({
    level: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    message: { type: String, required: true },
    source: { type: String, required: true }, // e.g., 'SocketService', 'TradeService'
    configId: { type: String, default: null },
    pair: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now }
});

export const LogModel = mongoose.model('Log', logSchema);
