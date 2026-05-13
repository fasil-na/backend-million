import { LogModel } from '../models/Log.js';

type Broadcaster = (log: any) => void;

export class LoggerService {
    static async log(level: 'info' | 'success' | 'warning' | 'error', message: string, source: string, context?: { configId?: string, pair?: string, metadata?: any }) {
        const logData = {
            level,
            message,
            source,
            configId: context?.configId,
            pair: context?.pair,
            metadata: context?.metadata,
            timestamp: new Date()
        };

        try {
            // 1. Save to DB
            const logEntry = new LogModel(logData);
            await logEntry.save();

            // 2. Broadcast to Frontend via registered broadcaster
            if (this.broadcaster) {
                this.broadcaster(logData);
            }

            // 3. Console Log
            const icon = level === 'success' ? '✅' : level === 'error' ? '❌' : level === 'warning' ? '⚠️' : 'ℹ️';
            console.log(`${icon} [${source}] ${message}`);
        } catch (err) {
            console.error('Failed to save log:', err);
        }
    }

    static async getRecentLogs(limit = 100) {
        return await LogModel.find().sort({ timestamp: -1 }).limit(limit).lean();
    }

    static async clearLogs() {
        await LogModel.deleteMany({});
    }

    private static broadcaster: Broadcaster | null = null;

    static setBroadcaster(fn: Broadcaster) {
        this.broadcaster = fn;
    }
}
