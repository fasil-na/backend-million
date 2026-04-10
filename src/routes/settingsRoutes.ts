import { Router } from 'express';
import { SettingsController } from '../controllers/SettingsController.js';

const router = Router();

router.get('/', SettingsController.getSettings);
router.post('/', SettingsController.updateSettings);

export default router;
