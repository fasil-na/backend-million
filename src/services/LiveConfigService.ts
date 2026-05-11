import { LiveConfigModel } from '../models/LiveConfig.js';

export class LiveConfigService {
    static async getEnabledConfigs() {
        return await LiveConfigModel.find({ isEnabled: true }).lean();
    }

    static async getConfig(id: string) {
        return await LiveConfigModel.findById(id).lean();
    }

    static async saveConfig(config: any) {
        if (config._id) {
            return await LiveConfigModel.findByIdAndUpdate(config._id, config, { new: true });
        }
        return await LiveConfigModel.create(config);
    }

    static async deleteConfig(id: string) {
        return await LiveConfigModel.findByIdAndDelete(id);
    }
}
