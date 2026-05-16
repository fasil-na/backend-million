import mongoose from 'mongoose';

const liveConfigSchema = new mongoose.Schema({
    pair: { type: String, required: true },
    strategyId: { type: String, required: true },
    timeInterval: { type: String, default: '1' },
    leverage: { type: Number, default: 10 },
    riskAmount: { type: Number, default: 5 },
    riskMode: { type: String, default: 'minimal' },
    autoTrade: { type: Boolean, default: false },
    isEnabled: { type: Boolean, default: true },
    maxPositionSize: { type: Number, default: 100 }
}, {
    timestamps: true
});

export const LiveConfigModel = mongoose.model('LiveConfig', liveConfigSchema);
