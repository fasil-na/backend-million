import { LiveConfigModel } from '../models/LiveConfig.js';
import type { ILiveConfig } from '../models/LiveConfig.js';

export class LiveConfigService {
    static async getAllConfigs() {
        return await LiveConfigModel.find({});
    }

    static async getConfigByPair(pair: string) {
        return await LiveConfigModel.findOne({ pair });
    }

    static async getEnabledConfigs() {
        return await LiveConfigModel.find({ isEnabled: true });
    }

    static async createConfig(config: Partial<ILiveConfig>) {
        const newConfig = new LiveConfigModel(config);
        return await newConfig.save();
    }

    static async updateConfig(id: string, updates: Partial<ILiveConfig>) {
        return await LiveConfigModel.findByIdAndUpdate(id, updates, { new: true });
    }

    static async deleteConfig(id: string) {
        return await LiveConfigModel.findByIdAndDelete(id);
    }

    static async toggleEnabled(id: string) {
        const config = await LiveConfigModel.findById(id);
        if (!config) throw new Error('Config not found');
        config.isEnabled = !config.isEnabled;
        return await config.save();
    }
}
