import { SettingsModel } from '../models/Settings.js';

export interface AppSettings {
    isLiveMonitoring: boolean;
    isPaperTrading: boolean;
    isLiveTrading: boolean;
    leverage: number;
    timeInterval: string;
    pair: string;
    initialCapital: number;
    selectedStrategyId: string;
}

const DEFAULT_SETTINGS: AppSettings = {
    isLiveMonitoring: false,
    isPaperTrading: true,
    isLiveTrading: false,
    leverage: 1,
    timeInterval: '1',
    pair: 'B-BTC_USDT',
    initialCapital: 1000,
    selectedStrategyId: 'opening-breakout'
};

export class SettingsService {
    private static currentSettings: AppSettings | null = null;
    private static initialized = false;

    private static async initializeDBIfNeeded() {
        if (this.initialized) return;
        try {
            const count = await SettingsModel.countDocuments();
            if (count === 0) {
                console.log("[Settings] First time setup: creating default settings in MongoDB.");
                await SettingsModel.create(DEFAULT_SETTINGS);
            }
        } catch (e) {
            console.error("[Settings] Error initializing settings:", e);
        }
        this.initialized = true;
    }

    static async init() {
        await this.initializeDBIfNeeded();
        try {
            const settings = await SettingsModel.findOne().lean();
            if (settings) {
                // Remove _id and __v from the result
                const { _id, __v, createdAt, updatedAt, ...rest } = settings as any;
                this.currentSettings = rest as AppSettings;
            } else {
                this.currentSettings = { ...DEFAULT_SETTINGS };
            }
        } catch (err) {
            console.error('Failed to initialize settings from MongoDB:', err);
            this.currentSettings = { ...DEFAULT_SETTINGS };
        }
    }

    static getSettings(): AppSettings {
        if (!this.currentSettings) {
            return DEFAULT_SETTINGS;
        }
        return this.currentSettings;
    }

    static async saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
        const updated = { ...this.getSettings(), ...settings };
        this.currentSettings = updated;

        try {
            await SettingsModel.findOneAndUpdate({}, updated, { upsert: true, new: true });
        } catch (err) {
            console.error('Failed to save settings to MongoDB:', err);
        }

        return updated;
    }
}
