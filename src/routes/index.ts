import { Router } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
import tradeRoutes from './tradeRoutes.js';
import marketRoutes from './marketRoutes.js';
import tradeHistoryRoutes from './tradeHistoryRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import liveConfigRoutes from './liveConfigRoutes.js';

const router = Router();

// --- Route Groups ---
router.use('/trade', tradeRoutes);
router.use('/market', marketRoutes);
router.use('/trade-history', tradeHistoryRoutes);
router.use('/settings', settingsRoutes);
router.use('/live-configs', liveConfigRoutes);

// --- Health Check (Enhanced) ---
router.get('/health', async (req, res) => {
  try {
    // Example checks (you will plug real ones)
    const health = {
      status: 'ok',
      timestamp: dayjs().tz('Asia/Kolkata').format(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      // socket: socketService.isConnected(),
      // exchange: await checkExchangeConnection(),
    };

    res.json(health);
  } catch (error:any) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

export default router;