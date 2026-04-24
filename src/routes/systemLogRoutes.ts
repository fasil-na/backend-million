import { Router } from 'express';
import { SystemLogController } from '../controllers/SystemLogController.js';

const router = Router();

router.get('/', SystemLogController.getLogs);
router.delete('/', SystemLogController.clearLogs);

export default router;
