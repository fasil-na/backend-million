import mongoose from 'mongoose';

export interface ILiveConfig {
    _id?: string;
    strategyId: string;
    pair: string;
    timeInterval: string;
    leverage: number;
    initialCapital: number;
    isEnabled: boolean;
    isLiveTrading: boolean;
    riskMode: 'minimal' | 'capital';
    maxPositionSize: number;
}

const liveConfigSchema = new mongoose.Schema({
    strategyId: { type: String, required: true },
    pair: { type: String, required: true },
    timeInterval: { type: String, default: '1' },
    leverage: { type: Number, default: 1 },
    initialCapital: { type: Number, default: 1000 },
    isEnabled: { type: Boolean, default: true },
    isLiveTrading: { type: Boolean, default: false },
    riskMode: { type: String, enum: ['minimal', 'capital'], default: 'minimal' },
    maxPositionSize: { type: Number, default: 100 }
}, {
    timestamps: true
});

export const LiveConfigModel = mongoose.model('LiveConfig', liveConfigSchema);
