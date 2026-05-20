import { TradeService } from './src/services/TradeService.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    await TradeService.cancelAllOrders('B-BTC_USDT');
    console.log("Cancelled orphaned orders!");
}
run();
