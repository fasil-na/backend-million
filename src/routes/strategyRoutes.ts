import { Router } from 'express';
import { DailyAnalysisController } from '../controllers/DailyAnalysisController.js';

const router = Router();

router.get('/daily-analysis', DailyAnalysisController.getDailyAnalysis);

export default router;
