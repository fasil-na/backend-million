import mongoose from "mongoose";
import { SocketService } from "./services/SocketService.js";
import { config } from "dotenv";

config();

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/million");
    console.log("Connected to DB");
    await SocketService.recoverTodayTrades();
    console.log("Recovery complete");
    process.exit(0);
}

run();
