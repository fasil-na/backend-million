import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import crypto from 'crypto';
import dummyData from './data/dummy_15m.json' with { type: 'json' };
import { strategies } from './strategies/index.js';
import type { Candle, Trade } from './types/index.js';
import { strategyBuilder } from './strategies/strategyBuilder.js';
import { coinDCXSocket } from './services/CoinDCXSocketService.js';
import http from 'http';
import { Server, Socket } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAPER_TRADES_FILE = path.join(__dirname, 'paperTrades.json');

dayjs.extend(utc);
dayjs.extend(timezone);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());
// CoinDCX API Details
const COINDCX_URL = "https://public.coindcx.com/market_data/candlesticks";

// Fetch dynamic leverage for futures
async function getInstrumentLeverage(pair: string): Promise<number> {
    try {
        const url = `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=USDT`;
        const response = await axios.get(url);
        if (response.data && response.data.instrument) {
            // Priority to max_leverage_long, fallback to 1
            const lev = response.data.instrument.max_leverage_long || 1;
            return lev;
        }
        return 1;
    } catch (error) {
        // Fallback to 1 if API fails
        console.error(`Failed to fetch leverage for ${pair}:`, error);
        return 1;
    }
}

app.post('/api/trade/execute', async (req: Request, res: Response) => {
    try {
        const apiKey = process.env.COINDCX_API_KEY;
        const apiSecret = process.env.COINDCX_API_SECRET;
        const { side, pair, price, capital = 100, orderType = "limit_order" } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({ error: 'Backend API Key and Secret are not configured' });
        }

        // Fetch market details to get precision
        const marketDetailsResponse = await axios.get('https://apigw.coindcx.com/exchange/v1/markets_details');
        const marketDetails = marketDetailsResponse.data.find((m: any) => m.coindcx_name === (pair || 'DOGEINR'));

        console.log(marketDetails, 'marketDetails------')

        if (!marketDetails) {
            return res.status(404).json({ error: `Market details not found for ${pair || 'DOGEINR'}` });
        }

        const targetPrecision = marketDetails.target_currency_precision;
        const basePrecision = marketDetails.base_currency_precision;

        // Bankruptcy & Compounding logic
        if (capital <= 0) {
            return res.status(400).json({ error: 'Insufficient capital (Bankruptcy)' });
        }

        // Calculate quantity based on capital for compounding
        // In a real scenario, you'd also consider riskPerTrade here if passed
        const quantityNum = capital / parseFloat(price || "1");
        const quantity = quantityNum.toFixed(targetPrecision).toString();

        const timeStamp = Date.now();
        const body = {
            side,
            order_type: "market_order",
            market: pair || 'DOGEINR',
            price_per_unit: price, // Use the passed price
            total_quantity: quantity,
            timestamp: timeStamp,
            client_order_id: `T-${timeStamp}`
        };
        console.log(body, 'body-----')

        const bodyString = JSON.stringify(body);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(bodyString)
            .digest('hex');

        console.log('---------------------------');

        const response = await axios.post('https://apigw.coindcx.com/exchange/v1/orders/create', bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });

        res.json(response.data);
    } catch (error: any) {
        if (error.response) {
            console.error('CoinDCX API Error Response:', JSON.stringify(error.response.data, null, 2));
            return res.status(error.response.status).json(error.response.data);
        }
        console.error('Execution Error:', error.message);
        res.status(500).json({ error: 'Trade execution failed: ' + error.message });
    }
});

app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok', timestamp: new Date().toISOString()

    });
});

app.post('/api/user/balances', async (req: Request, res: Response) => {
    try {
        const apiKey = process.env.COINDCX_API_KEY;
        const apiSecret = process.env.COINDCX_API_SECRET;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({ error: 'Backend API Key and Secret are not configured' });
        }

        const timeStamp = Date.now();
        const body = {
            timestamp: timeStamp
        };

        const bodyString = JSON.stringify(body);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(bodyString)
            .digest('hex');

        const response = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });

        res.json(response.data);
    } catch (error: any) {
        if (error.response) {
            console.error('CoinDCX API Error Response:', JSON.stringify(error.response.data, null, 2));
            return res.status(error.response.status).json(error.response.data);
        }
        res.status(500).json({ error: 'Failed to fetch balances: ' + error.message });
    }
});

app.get('/api/strategies', (_req: Request, res: Response) => {
    const strategyList = Object.values(strategies).map(s => ({
        id: s.id,
        name: s.name,
        description: s.description
    }));
    res.json(strategyList);
});

app.get('/api/market-data', async (req: Request, res: Response) => {
    try {
        const { pair = 'B-BTC_USDT', resolution = '60', from, to } = req.query;

        // Ensure we always use live data unless explicitly requested otherwise for dev
        const useDummy = req.query.useDummy === 'true';
        if (useDummy) {
            return res.json(dummyData);
        }

        const now = Math.floor(Date.now() / 1000);
        const yesterday = now - (24 * 60 * 60);

        const params = {
            pair,
            from: Number(from || yesterday),
            to: Number(to || now),
            resolution: String(resolution),
            pcode: 'f'
        };

        const response = await axios.get(COINDCX_URL, { params });
        res.json(response.data);
    } catch (error: any) {
        if (error.response) {
            console.error('Exchange error response:', error.response.status, error.response.data);
        } else {
            console.error('Error fetching market data:', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch market data from exchange' });
    }
});

app.get('/api/ticker', async (req: Request, res: Response) => {
    try {
        const { pair = "BTCUSDT" } = req.query;
        // CoinDCX ticker returns an array of all pairs
        const response = await axios.get('https://api.coindcx.com/exchange/ticker');
        const ticker = response.data.find((t: any) => t.market === pair);
        if (ticker) {
            res.json({ last_price: ticker.last_price });
        } else {
            res.status(404).json({ error: 'Pair not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch ticker' });
    }
});

app.get('/api/leverage/:pair', async (req: Request, res: Response) => {
    try {
        const { pair } = req.params;
        const leverage = await getInstrumentLeverage(pair as string);
        res.json({ leverage });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch leverage' });
    }
});

app.post('/api/backtest', async (req: Request, res: Response) => {
    try {
        const {
            isLive,
            from,
            to,
            month,
            year,
            startYear,
            startMonth,
            endYear,
            endMonth,
            pair = "B-BTC_USDT",
            capitalPerTrade = 1,
            resolution = "5",
            atrMultiplierSL = 10,
            feeRate = 0.0002
        } = req.body;

        // Dynamic Leverage
        let leverage = req.body.leverage;
        if (!leverage || leverage <= 0) {
            leverage = await getInstrumentLeverage(pair);
        }

        let currentCapital = req.body.capital || req.body.capitalPerTrade || 1000;
        const initialCapital = currentCapital;
        let allTrades: Trade[] = [];
        let periods: { year: number, month: number }[] = [];

        if (isLive) {
            const todayStart = dayjs().tz('Asia/Kolkata').startOf('day');
            periods.push({ year: todayStart.year(), month: todayStart.month() });
        } else if (startYear !== undefined && startMonth !== undefined && endYear !== undefined && endMonth !== undefined) {
            let current = dayjs().year(startYear).month(startMonth).startOf('month');
            const end = dayjs().year(endYear).month(endMonth).endOf('month');
            while (current.isBefore(end)) {
                periods.push({ year: current.year(), month: current.month() });
                current = current.add(1, 'month');
            }
        } else if (year !== undefined && month !== undefined) {
            periods.push({ year, month });
        } else {
            // Fallback to 'from' and 'to' or last 30 days
            const s = from ? dayjs.unix(from) : dayjs().subtract(30, 'days');
            const e = to ? dayjs.unix(to) : dayjs();
            let current = s.startOf('month');
            while (current.isBefore(e)) {
                periods.push({ year: current.year(), month: current.month() });
                current = current.add(1, 'month');
            }
        }

        for (const period of periods) {
            const monthStart = dayjs().year(period.year).month(period.month).startOf('month');
            const monthEnd = dayjs().year(period.year).month(period.month).endOf('month');

            let simulationStartUnix = Math.floor(monthStart.valueOf() / 1000);
            let dataFetchStartUnix = simulationStartUnix - (24 * 60 * 60);
            let endUnix = Math.floor(monthEnd.valueOf() / 1000);

            if (isLive) {
                const todayStart = dayjs().tz('Asia/Kolkata').startOf('day');
                simulationStartUnix = Math.floor(todayStart.valueOf() / 1000);
                dataFetchStartUnix = simulationStartUnix - (24 * 60 * 60);
                endUnix = Math.floor(Date.now() / 1000);
            }

            try {
                // Fetch both main resolution and 1m resolution for SL precision
                const [response, subResponse] = await Promise.all([
                    axios.get(COINDCX_URL, {
                        params: { pair, from: dataFetchStartUnix, to: endUnix, resolution, pcode: 'f' }
                    }),
                    axios.get(COINDCX_URL, {
                        params: { pair, from: dataFetchStartUnix, to: endUnix, resolution: '1', pcode: 'f' }
                    }).catch(() => ({ data: { s: 'error', data: [] } })) // Optional 1m data
                ]);

                if (response.data.s === 'ok' && Array.isArray(response.data.data)) {
                    const candles: Candle[] = response.data.data.sort((a: Candle, b: Candle) => a.time - b.time);
                    const subCandles: Candle[] = Array.isArray(subResponse.data.data)
                        ? subResponse.data.data.sort((a: Candle, b: Candle) => a.time - b.time)
                        : [];

                    const strategyId = req.body.strategyId || 'opening-breakout';
                    const strategy = strategies[strategyId];

                    if (strategy) {
                        const { trades, finalBalance } = strategy.run(candles, {
                            ...req.body,
                            leverage, // Override with dynamic leverage
                            capital: currentCapital, // Pass current balance for compounding
                            simulationStartUnix
                        }, subCandles);
                        allTrades.push(...trades);
                        currentCapital = finalBalance; // Update balance for next period/trade

                        if (currentCapital <= 0) {
                            console.log("Backtest BANKRUPTCY: Stopping simulation.");
                            break;
                        }
                    }
                }
            } catch (err) {
                console.error(`Error in period ${period.year}-${period.month}:`, err);
            }
        }

        const summary = {
            totalProfit: allTrades.reduce((a, t) => a + t.profit, 0),
            totalFee: allTrades.reduce((a, t) => a + (t.fee || 0), 0),
            count: allTrades.length,
            successCount: allTrades.filter(t => t.profit > 0).length,
            failedCount: allTrades.filter(t => t.profit <= 0).length,
            winRate: allTrades.length > 0 ? (allTrades.filter(t => t.profit > 0).length / allTrades.length) * 100 : 0,
            initialCapital,
            finalBalance: currentCapital
        };

        res.json({ trades: allTrades, summary });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: 'Backtest failed' });
    }
});

// Paper Trade Endpoints
app.post('/api/paper-trade', (req: Request, res: Response) => {
    try {
        const { trade, pair } = req.body;
        if (!trade) {
            return res.status(400).json({ error: 'Trade data is required' });
        }

        let paperTrades = [];
        if (fs.existsSync(PAPER_TRADES_FILE)) {
            const data = fs.readFileSync(PAPER_TRADES_FILE, 'utf-8');
            paperTrades = JSON.parse(data);
        }

        const newTrade = {
            ...trade,
            pair: pair || 'B-BTC_USDT',
            id: crypto.randomUUID(),
            recordedAt: new Date().toISOString()
        };

        paperTrades.push(newTrade);
        fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(paperTrades, null, 2));

        res.json({ success: true, trade: newTrade });
    } catch (err: any) {
        console.error('Error saving paper trade:', err);
        res.status(500).json({ error: 'Failed to record paper trade' });
    }
});

app.get('/api/paper-trades', (req: Request, res: Response) => {
    try {
        if (!fs.existsSync(PAPER_TRADES_FILE)) {
            return res.json([]);
        }
        const data = fs.readFileSync(PAPER_TRADES_FILE, 'utf-8');
        res.json(JSON.parse(data));
    } catch (err: any) {
        console.error('Error fetching paper trades:', err);
        res.status(500).json({ error: 'Failed to fetch paper trades' });
    }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Socket Subscription Configuration ---
const DEFAULT_PAIR = 'B-BTC_USDT';
const DEFAULT_RESOLUTION = '1m';

function formatChannelName(pair: string, resolution: string = DEFAULT_RESOLUTION) {
    const instrument = pair.includes('B-') ? pair : `B-${pair}`;
    return `${instrument}_${resolution}-futures`;
}

io.on('connection', (socket: Socket) => {
    console.log('Frontend connected to local socket:', socket.id);

    socket.on('subscribe', (pair: string) => {
        const channelName = formatChannelName(pair || DEFAULT_PAIR);
        console.log(`Subscribing to CoinDCX channel: ${channelName}`);
        coinDCXSocket.subscribe(channelName);
    });
});

// Track state for autonomous 24/7 strategy execution
let lastCandleTime: number | null = null;

// Hook up internal socket forwarding
coinDCXSocket.on('candlestick', (data) => {
    // console.log('Received candlestick data, forwarding to frontend...', data);
    io.emit('candlestick', data);

    // BAR CLOSE DETECTION LOGIC
    if (lastCandleTime !== null && data.time > lastCandleTime) {
        console.log(`✅ ${DEFAULT_RESOLUTION} Candle Closed at ${new Date(lastCandleTime * 1000).toISOString()}. Running strategies...`);
        // 👉 EXECUTE STRATEGY HERE 24/7
    }
    lastCandleTime = data.time;
});

coinDCXSocket.on('price-change', (data) => {
    io.emit('price-change', data);
});

coinDCXSocket.connect();

// Autonomous 24/7 listening for the default pair on startup
coinDCXSocket.once('connected', () => {
    const initialChannel = formatChannelName(DEFAULT_PAIR);
    console.log(`Starting autonomous 24/7 listening for ${initialChannel}`);
    coinDCXSocket.subscribe(initialChannel);

    // Also subscribe to bulk price updates for all futures
    console.log('Subscribing to bulk futures price updates (Ticker)');
    coinDCXSocket.subscribe('currentPrices@futures#update');
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
