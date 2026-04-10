import { Router } from 'express';
import { PaperTradeController } from '../controllers/PaperTradeController.js';

const router = Router();

router.post('/', PaperTradeController.record);
router.get('/', PaperTradeController.list);

export default router;
