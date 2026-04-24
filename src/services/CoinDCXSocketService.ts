import { io, Socket } from 'socket.io-client';
import crypto from 'crypto';
import EventEmitter from 'events';
import { SystemLogService } from './SystemLogService.js';

export interface SocketConfig {
    apiKey: string;
    apiSecret: string;
    endpoint?: string;
}

export class CoinDCXSocketService extends EventEmitter {
    private socket: Socket | null = null;
    private apiKey: string;
    private apiSecret: string;
    private endpoint: string;
    private authenticated: boolean = false;
    private subscriptions: Set<string> = new Set();
    private lastPrices: Map<string, any> = new Map();
    private lastBalances: any[] = [];
    private lastCandleTime: number = Date.now();

    constructor(config: SocketConfig) {
        super();
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.endpoint = "wss://stream.coindcx.com/";

        setInterval(() => {
            const diff = Date.now() - this.lastCandleTime;
            if (diff > 60000 && this.subscriptions.size > 0) {
                SystemLogService.log('WARN', 'SOCKET', '🚨 No candle data for 60s. Forcing reconnection.');
                this.disconnect();
                this.connect();
            }
        }, 30000);
    }

    public connect() {
        if (this.socket?.connected) return;

        this.lastCandleTime = Date.now(); // 🛡️ RESET TIMER: Give the socket a fresh 60s to start receiving data
        console.log(`Connecting to CoinDCX Socket at ${this.endpoint}...`);

        this.socket = io(this.endpoint, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity, // ♾️ NEVER GIVE UP: Keep trying until the internet returns
            reconnectionDelay: 2000,
            reconnectionDelayMax: 30000, // Gradually slow down to every 30s if the server is totally down
            timeout: 20000,
        });

        this.socket.removeAllListeners();

        this.socket.on('connect', () => {
            SystemLogService.log('INFO', 'SOCKET', '✅ Connected to CoinDCX');
            this.authenticate();
            this.resubscribe();
            this.emit('connected');
        });

        this.socket.on('disconnect', (reason) => {
            SystemLogService.log('WARN', 'SOCKET', `❌ Disconnected from CoinDCX`, { reason });
            this.authenticated = false;
            this.emit('disconnected', reason);
        });

        this.socket.on('connect_error', (error) => {
            SystemLogService.log('ERROR', 'SOCKET', `🔥 Connection Error: ${error.message}`);
            this.emit('socket_error', error);
        });

        this.registerListeners();
    }

    private authenticate() {
        if (!this.socket) return;

        const body = { channel: "coindcx" };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');

        console.log('Authenticating with CoinDCX...');
        this.socket.emit('join', {
            'channelName': "coindcx",
            'authSignature': signature,
            'apiKey': this.apiKey
        });
        this.authenticated = true;
    }

    public subscribe(channelName: string) {
        this.subscriptions.add(channelName);
        if (this.socket?.connected) {
            console.log(`Subscribing to channel: ${channelName}`);
            this.socket.emit('join', { channelName });
        }
    }

    public unsubscribe(channelName: string) {
        this.subscriptions.delete(channelName);
        if (this.socket?.connected) {
            console.log(`Unsubscribing from channel: ${channelName}`);
            this.socket.emit('leave', { channelName });
        }
    }

    private resubscribe() {
        if (!this.socket?.connected) return;
        for (const channel of this.subscriptions) {
            console.log(`Resubscribing to channel: ${channel}`);
            this.socket.emit('join', { channelName: channel });
        }
    }

    private registerListeners() {
        if (!this.socket) return

        this.socket.on("balance-update", (response) => {
            this.lastBalances = response.data;
            this.emit('balance-update', response.data);
        });

        this.socket.on("order-update", (response) => {
            this.emit('order-update', response.data);
        });

        this.socket.on("candlestick", (response) => {
            this.lastCandleTime = Date.now();
            try {
                // If data is a string (double-encoded JSON), parse it
                const parsed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                
                const candleData = Array.isArray(parsed.data) ? parsed.data[0] : (parsed.data || parsed);

                if (candleData && (candleData.open_time || candleData.t)) {
                    // Map to common format expected by frontend
                    let time = candleData.open_time || candleData.t;
                    if (time < 10000000000) time *= 1000; // Convert seconds to milliseconds

                    // Extract pair from channel if possible (e.g. "B-BTC_USDT_1m-futures")
                    let pair = candleData.pair || candleData.s || parsed.channel || response.channel || "";
                    if (pair && pair.includes('_')) {
                        const parts = pair.split('_');
                        if (parts.length >= 2) {
                            pair = `${parts[0]}_${parts[1]}`.replace('-futures', '');
                        }
                    }

                    // Extract resolution from channel (e.g. "B-BTC_USDT_5m-futures" -> "5")
                    const channel = (parsed.channel || response.channel || "");
                    const resMatch = channel.match(/_(\d+)[mhd]/);
                    const resolution = resMatch ? resMatch[1] : '1';

                    const safe = (v: any) => {
                        const n = Number(v);
                        return isNaN(n) ? 0 : n;
                    };

                    const formattedCandle = {
                        time: time,
                        pair: pair,
                        resolution: resolution,
                        open: safe(candleData.open || candleData.o),
                        high: safe(candleData.high || candleData.h),
                        low: safe(candleData.low || candleData.l),
                        close: safe(candleData.close || candleData.c),
                        volume: safe(candleData.volume || candleData.v)
                    };
                    this.emit('candlestick', formattedCandle);
                } else {
                    console.log('[Socket Service] No valid candle data in response');
                }
            } catch (err) {
                console.error('Error parsing candlestick data:', err);
                this.emit('candlestick', response.data || response);
            }
        });

        this.socket.on("new-trade", (response) => {
            this.emit('new-trade', response.data);
        });

        this.socket.on("df-position-update", (response) => {
            this.emit('df-position-update', response.data);
        });

    }

    public disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.authenticated = false;
        }
    }

    public isConnected(): boolean {
        return this.socket?.connected || false;
    }

    public isAuthenticated(): boolean {
        return this.authenticated;
    }

    public getLastPrices() {
        return Object.fromEntries(this.lastPrices);
    }

    public getLastBalances() {
        return this.lastBalances;
    }
}

export const coinDCXSocket = new CoinDCXSocketService({
    apiKey: process.env.COINDCX_API_KEY || '',
    apiSecret: process.env.COINDCX_API_SECRET || ''
});
