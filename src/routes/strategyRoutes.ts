import { Router } from 'express';
import { DailyAnalysisController } from '../controllers/DailyAnalysisController.js';
import { FVGAnalysisController } from '../controllers/FVGAnalysisController.js';

const router = Router();

router.get('/daily-analysis', DailyAnalysisController.getDailyAnalysis);
router.get('/fvg-analysis', FVGAnalysisController.getDailyAnalysis);

export default router;
