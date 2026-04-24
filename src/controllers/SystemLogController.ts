import type { Request, Response } from 'express';
import { SystemLogService } from '../services/SystemLogService.js';

export class SystemLogController {
    static async getLogs(req: Request, res: Response) {
        try {
            const logs = await SystemLogService.getRecentLogs(200);
            res.json(logs);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    static async clearLogs(req: Request, res: Response) {
        try {
            await SystemLogService.clearLogs();
            res.json({ message: 'Logs cleared successfully' });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
}
