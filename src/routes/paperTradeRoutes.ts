import { Router } from 'express';
import { PaperTradeController } from '../controllers/PaperTradeController.js';

const router = Router();

router.post('/', PaperTradeController.record);
router.get('/', PaperTradeController.list);
router.delete('/clear', PaperTradeController.clear);
router.delete('/:entryTime', PaperTradeController.delete);

export default router;
