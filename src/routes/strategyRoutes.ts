import { Router } from 'express';
import { StrategyController } from '../controllers/StrategyController.js';

const router = Router();

router.get('/fvg-analysis', StrategyController.getFVGAnalysis);

export default router;
