import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    isLiveMonitoring: { type: Boolean, default: false },
    isPaperTrading: { type: Boolean, default: true },
    isLiveTrading: { type: Boolean, default: false },
    leverage: { type: Number, default: 1 },
    timeInterval: { type: String, default: '1' },
    pair: { type: String, default: 'B-BTC_USDT' },
    initialCapital: { type: Number, default: 1000 },
    selectedStrategyId: { type: String, default: 'opening-breakout' },
    bankBalance: { type: Number, default: 0 },
    activeTradeStatus: { type: String, default: 'closed' }
}, {
    timestamps: true,
    // We only ever want one settings document for this app
    // We'll use a fixed ID for it
    capped: { size: 1024, max: 1, autoIndexId: true }
});

export const SettingsModel = mongoose.model('Settings', settingsSchema);
