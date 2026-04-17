import { Router } from 'express';
import { TradeHistoryController } from '../controllers/TradeHistoryController.js';

const router = Router();

router.get('/', TradeHistoryController.list);
router.delete('/clear', TradeHistoryController.clear);
router.delete('/:entryTime', TradeHistoryController.delete);

export default router;
