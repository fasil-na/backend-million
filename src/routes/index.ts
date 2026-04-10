import { Router } from 'express';
import tradeRoutes from './tradeRoutes.js';
import marketRoutes from './marketRoutes.js';
import paperTradeRoutes from './paperTradeRoutes.js';
import settingsRoutes from './settingsRoutes.js';

const router = Router();

router.use('/trade', tradeRoutes);
router.use('/', marketRoutes);
router.use('/paper-trade', paperTradeRoutes);
router.use('/paper-trades', paperTradeRoutes);
router.use('/settings', settingsRoutes);

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

export default router;
