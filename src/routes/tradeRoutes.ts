import { Router } from 'express';
import { TradeController } from '../controllers/TradeController.js';

const router = Router();

router.post('/execute', TradeController.execute);
router.post('/balances', TradeController.getBalances);
router.get('/logs', TradeController.getLogs);
router.delete('/logs', TradeController.clearLogs);

export default router;

