import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { coinDCXSocket } from './CoinDCXSocketService.js';
import { DEFAULT_PAIR, DEFAULT_RESOLUTION, COINDCX_URL } from '../config/constants.js';
import { strategies } from '../strategies/index.js';
import axios from 'axios';
import dayjs from 'dayjs';
import type { Candle } from '../types/index.js';

export class SocketService {
    private static io: SocketIOServer;
    private static lastCandleTime: number | null = null;

    static init(server: HTTPServer) {
        this.io = new SocketIOServer(server, { cors: { origin: '*' } });

        this.io.on('connection', (socket) => {
            console.log('Frontend connected:', socket.id);
            socket.on('subscribe', (pair: string) => {
                const channel = this.formatChannel(pair || DEFAULT_PAIR);
                console.log(`Subscribing to: ${channel}`);
                coinDCXSocket.subscribe(channel);
            });
        });

        this.setupCoinDCXListeners();
        coinDCXSocket.connect();
        
        coinDCXSocket.once('connected', () => {
            const channel = this.formatChannel(DEFAULT_PAIR);
            console.log(`Subscribing to default channel: ${channel}`);
            coinDCXSocket.subscribe(channel);
        });
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}-futures`;
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data) => {
            this.io.emit('candlestick', data);
            this.io.emit('price-change', { m: DEFAULT_PAIR, p: data.close });

            if (this.lastCandleTime !== null && data.time > this.lastCandleTime) {
                console.log(`✅ Candle Closed at ${new Date(this.lastCandleTime).toISOString()}. Running strategies...`);
                await this.executeLiveStrategy(DEFAULT_PAIR);
            }
            this.lastCandleTime = data.time;
        });
    }

    private static async executeLiveStrategy(pair: string) {
        try {
            console.log(`[Autonomous] Running strategy for ${pair}...`);
            const now = Math.floor(Date.now() / 1000);
            const from = now - (100 * 60);

            const response = await axios.get(COINDCX_URL, {
                params: { pair, from, to: now, resolution: '1', pcode: 'f' }
            });

            if (response.data.s === 'ok' && Array.isArray(response.data.data)) {
                const candles: Candle[] = response.data.data.sort((a: Candle, b: Candle) => a.time - b.time);
                const strategy = strategies['opening-breakout'];

                if (strategy) {
                    const { trades } = strategy.run(candles, {
                        capital: 1000, leverage: 1, atrMultiplierSL: 10, simulationStartUnix: from
                    });

                    if (trades.length > 0) {
                        const latest = trades[trades.length - 1];
                        const lastCandle = candles[candles.length - 1];
                        if (Math.abs(dayjs(latest?.entryTime).valueOf() - (lastCandle?.time || 0)) < 60000) {
                            console.log("🚀 NEW STRATEGY SIGNAL:", latest);
                            this.io.emit('strategy-signal', { pair, trade: latest });
                        }
                    }
                }
            }
        } catch (err: any) {
            console.error("Autonomous strategy failed:", err.message);
        }
    }
}
