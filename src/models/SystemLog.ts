import mongoose from 'mongoose';

const SystemLogSchema = new mongoose.Schema({
    timestamp: { type: String, required: true },
    level: { type: String, enum: ['INFO', 'WARN', 'ERROR'], default: 'INFO' },
    source: { type: String, required: true }, // e.g., 'SOCKET', 'STRATEGY', 'EXCHANGE'
    message: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed },
}, {
    timestamps: true,
    capped: { size: 10485760, max: 100 } // 10MB size limit, 100 documents max
});

export const SystemLogModel = mongoose.model('SystemLog', SystemLogSchema);
