import mongoose from "mongoose";
import { TradeModel } from "./models/Trade.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { config } from "dotenv";

config();
dayjs.extend(utc);
dayjs.extend(timezone);

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/million");
    const targetDate = dayjs().tz('Asia/Kolkata');
    const startStr = targetDate.startOf('day').format();
    const endStr = targetDate.endOf('day').format();
    const count = await TradeModel.countDocuments({
        entryTime: { $gte: startStr, $lte: endStr }
    });
    console.log("DB Trades Count:", count);
    process.exit(0);
}

run();
