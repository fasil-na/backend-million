import dotenv from 'dotenv';
dotenv.config();

export const COINDCX_URL = "https://public.coindcx.com/market_data/candlesticks";

export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/million';


export const DEFAULT_PAIR = 'B-BTC_USDT';
export const DEFAULT_RESOLUTION = '1m';
