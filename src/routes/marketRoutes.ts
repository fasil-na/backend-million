import { Router } from 'express';
import { MarketController } from '../controllers/MarketController.js';
import { StrategyController } from '../controllers/StrategyController.js';

const router = Router();

router.get('/market-data', MarketController.getCandlesticks);
router.get('/leverage/:pair', MarketController.getLeverage);
router.get('/strategies', StrategyController.getList);
router.post('/backtest', StrategyController.runBacktest);

export default router;
