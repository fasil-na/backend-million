import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

export class SettingsService {
    private static currentSettings: AppSettings | null = null;

    static getSettings(): AppSettings {
        if (this.currentSettings) return this.currentSettings;

        try {
            if (fs.existsSync(SETTINGS_FILE)) {
                const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
                this.currentSettings = JSON.parse(data);
                return this.currentSettings!;
            }
        } catch (err) {
            console.error('Failed to read settings file:', err);
        }

        this.currentSettings = { ...DEFAULT_SETTINGS };
        this.saveSettings(this.currentSettings);
        return this.currentSettings;
    }

    static saveSettings(settings: Partial<AppSettings>): AppSettings {
        const updated = { ...this.getSettings(), ...settings };
        this.currentSettings = updated;

        try {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
        } catch (err) {
            console.error('Failed to save settings file:', err);
        }

        return updated;
    }
}
