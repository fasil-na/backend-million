import { type Request, type Response } from 'express';
import { SettingsService } from '../services/SettingsService.js';

export class SettingsController {
    static getSettings(req: Request, res: Response) {
        try {
            const settings = SettingsService.getSettings();
            res.json(settings);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    static updateSettings(req: Request, res: Response) {
        try {
            const settings = SettingsService.saveSettings(req.body);
            res.json(settings);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
}
