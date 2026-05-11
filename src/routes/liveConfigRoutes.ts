import { Router } from 'express';
import { LiveConfigController } from '../controllers/LiveConfigController.js';

const router = Router();

router.get('/', LiveConfigController.getConfigs);
router.post('/', LiveConfigController.saveConfig);
router.delete('/:id', LiveConfigController.deleteConfig);

export default router;
