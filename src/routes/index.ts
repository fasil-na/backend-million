import { Router } from 'express';
import tradeRoutes from './tradeRoutes.js';
import marketRoutes from './marketRoutes.js';
import tradeHistoryRoutes from './tradeHistoryRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import systemLogRoutes from './systemLogRoutes.js';

const router = Router();

// --- Route Groups ---
router.use('/trade', tradeRoutes);
router.use('/market', marketRoutes);
router.use('/trade-history', tradeHistoryRoutes);
router.use('/settings', settingsRoutes);
router.use('/system-logs', systemLogRoutes);

// --- Health Check (Enhanced) ---
router.get('/health', async (req, res) => {
  try {
    // Example checks (you will plug real ones)
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
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