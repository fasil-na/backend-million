import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const COINDCX_URL = "https://public.coindcx.com/market_data/candlesticks";

// Use a 'data' folder in the project root for persistence across deployments
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paperTrades.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_PAIR = 'B-BTC_USDT';
export const DEFAULT_RESOLUTION = '1m';
