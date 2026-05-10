import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    isLiveMonitoring: { type: Boolean, default: false },
    isLiveTrading: { type: Boolean, default: false }
}, {
    timestamps: true,
    // We only ever want one settings document for this app
    // We'll use a fixed ID for it
    capped: { size: 1024, max: 1, autoIndexId: true }
});

export const SettingsModel = mongoose.model('Settings', settingsSchema);
