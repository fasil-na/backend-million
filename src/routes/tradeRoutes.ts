import { Router } from 'express';
import { TradeController } from '../controllers/TradeController.js';

const router = Router();

router.post('/execute', TradeController.execute);
router.post('/balances', TradeController.getBalances);

export default router;
