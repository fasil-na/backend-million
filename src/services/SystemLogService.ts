import { SystemLogModel } from '../models/SystemLog.js';
import dayjs from 'dayjs';

export class SystemLogService {
    static async log(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string, details?: any) {
        try {
            // 1. Log to terminal IMMEDIATELY (Don't wait for DB)
            const icon = level === 'ERROR' ? '🚨' : level === 'WARN' ? '⚠️' : 'ℹ️';
            console.log(`[${icon} ${source}] ${message}`);

            // 2. Save to DB in the background (Don't block the strategy)
            const logEntry = new SystemLogModel({
                timestamp: dayjs().toISOString(),
                level,
                source,
                message,
                details
            });
            
            // We don't await this to avoid hanging the entire system if the DB is slow
            logEntry.save().catch(err => console.error('Failed to save system log to DB:', err));
        } catch (err) {
            console.error('SystemLogService logic failed:', err);
        }
    }

    static async getRecentLogs(limit = 100, level?: string) {
        const query: any = {};
        if (level && level !== 'ALL') {
            query.level = level;
        }
        return await SystemLogModel.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    }

    static async clearLogs() {
        return await SystemLogModel.deleteMany({});
    }
}
