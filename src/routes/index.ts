import { Router } from 'express';
import tradeRoutes from './tradeRoutes.js';
import marketRoutes from './marketRoutes.js';
import paperTradeRoutes from './paperTradeRoutes.js';

const router = Router();

router.use('/trade', tradeRoutes);
router.use('/', marketRoutes);
router.use('/paper-trade', paperTradeRoutes);
router.use('/paper-trades', paperTradeRoutes);

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

export default router;
