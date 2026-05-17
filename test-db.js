import mongoose from 'mongoose';
import { TradeModel } from './src/models/Trade.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/million-trading');
  const trades = await TradeModel.find({}).lean();
  console.log('Total trades:', trades.length);
  if (trades.length > 0) {
    console.log('Sample trade:', trades[0]);
  }
  process.exit(0);
}
run();
