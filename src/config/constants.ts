import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const COINDCX_URL = "https://public.coindcx.com/market_data/candlesticks";
export const PAPER_TRADES_FILE = path.join(process.cwd(), 'src', 'paperTrades.json');
export const DEFAULT_PAIR = 'B-BTC_USDT';
export const DEFAULT_RESOLUTION = '1m';
