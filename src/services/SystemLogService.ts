import { SystemLogModel } from '../models/SystemLog.js';
import dayjs from 'dayjs';

export class SystemLogService {
    static async log(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string, details?: any) {
        try {
            // 🛡️ DATABASE FILTER: Only save critical ERRORS to the DB to keep it clean.
            if (level === 'ERROR') {
                const logEntry = new SystemLogModel({
                    timestamp: dayjs().toISOString(),
                    level,
                    source,
                    message,
                    details
                });
                await logEntry.save();
            }
            
            // Log everything to terminal for immediate viewing
            const icon = level === 'ERROR' ? '🚨' : level === 'WARN' ? '⚠️' : 'ℹ️';
            console.log(`[${icon} ${source}] ${message}`);
        } catch (err) {
            console.error('Failed to save system log:', err);
        }
    }

    static async getRecentLogs(limit = 100) {
        return await SystemLogModel.find().sort({ createdAt: -1 }).limit(limit).lean();
    }

    static async clearLogs() {
        return await SystemLogModel.deleteMany({});
    }
}
