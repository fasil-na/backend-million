import mongoose from "mongoose";
import { TradeModel } from "./models/Trade.js";
import { LiveConfigModel } from "./models/LiveConfig.js";
import { CoinDCXApiService } from "./services/CoinDCXApiService.js";
import { strategies } from "./strategies/index.js";
import { TradeHistoryService } from "./services/TradeHistoryService.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { config } from "dotenv";

config();
dayjs.extend(utc);
dayjs.extend(timezone);

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/million");
    console.log("Connected to DB");

    const pair = "B-BTC_USDT";
    const resolution = "1";
    
    const todayKolkata = dayjs().tz('Asia/Kolkata').startOf('day');
    const startOfDay = todayKolkata.valueOf();
    const from = Math.floor((startOfDay - (12 * 60 * 60 * 1000)) / 1000); 
    const to = Math.floor(Date.now() / 1000);

    const liveConfig = await LiveConfigModel.findOne({ pair, strategyId: 'fvg-imbalance', isEnabled: true });
    
    if (!liveConfig) {
        console.log("No live config found");
        process.exit(0);
    }

    const [resMain, resSub] = await Promise.all([
        CoinDCXApiService.getCandlesticks({ pair, from, to, resolution }),
        CoinDCXApiService.getCandlesticks({ pair, from, to, resolution: '1' }).catch(() => ({ s: 'error', data: [] }))
    ]);

    const candles = resMain.data.sort((a: any, b: any) => a.time - b.time);
    const subCandles = Array.isArray(resSub.data) ? resSub.data.sort((a: any, b: any) => a.time - b.time) : [];

    const strategy = strategies['fvg-imbalance'] as any;
    const result = strategy.run(candles, {
        type: 'backtest',
        pair: pair,
        riskAmount: liveConfig.riskAmount,
        leverage: liveConfig.leverage,
        resolution: resolution,
        simulationStartUnix: Math.floor(startOfDay / 1000) 
    }, subCandles);

    if (result && result.trades) {
        console.log(`Simulation found ${result.trades.length} trades.`);
        let added = 0;
        for (const t of result.trades) {
            const overlap = await TradeHistoryService.findOverlap(pair, t.entryTime);
            if (!overlap) {
                await TradeHistoryService.saveTrade({ ...t, pair, configId: liveConfig._id.toString(), type: 'recovery', status: 'closed' });
                added++;
            }
        }
        console.log(`Added ${added} missing trades.`);
    }

    process.exit(0);
}

run();
