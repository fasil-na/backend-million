import { type Request, type Response } from 'express';
import { LiveConfigService } from '../services/LiveConfigService.js';
import { SocketService } from '../services/SocketService.js';

export class LiveConfigController {
    static async getConfigs(req: Request, res: Response) {
        try {
            const configs = await LiveConfigService.getEnabledConfigs();
            res.json(configs);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async saveConfig(req: Request, res: Response) {
        try {
            const config = req.body;
            const saved = await LiveConfigService.saveConfig(config);
            // Trigger engine to reload this config
            await SocketService.init(null as any); // This might be too aggressive, better just add the state
            res.json(saved);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    static async deleteConfig(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) return res.status(400).json({ error: 'Missing config ID' });
            
            await LiveConfigService.deleteConfig(id as string);
            await SocketService.removeConfigState(id as string);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
