import { io, Socket } from 'socket.io-client';
import crypto from 'crypto';
import EventEmitter from 'events';

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

    constructor(config: SocketConfig) {
        super();
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.endpoint = config.endpoint || "wss://mercury-socket-publisher.coindcx.com/";
    }

    public connect() {
        if (this.socket?.connected) return;

        console.log(`Connecting to CoinDCX Socket at ${this.endpoint}...`);

        this.socket = io(this.endpoint, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
        });

        this.socket.on('connect', () => {
            console.log('Connected to CoinDCX Socket');
            this.authenticate();
            this.resubscribe();
            this.emit('connected');
        });

        this.socket.on('disconnect', (reason) => {
            console.log(`Disconnected from CoinDCX Socket: ${reason}`);
            this.authenticated = false;
            this.emit('disconnected', reason);
        });

        this.socket.on('connect_error', (error) => {
            console.error('CoinDCX Socket Connection Error:', error.message);
            this.emit('error', error);
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
        if (!this.socket) return;

        this.socket.on("balance-update", (response) => {
            this.lastBalances = response.data;
            this.emit('balance-update', response.data);
        });

        this.socket.on("order-update", (response) => {
            this.emit('order-update', response.data);
        });

        this.socket.on("candlestick", (response) => {
            console.log('hitting---candle')
            this.emit('candlestick', response.data);
        });

        this.socket.on("currentPrices@spot#update", (response) => {
            this.lastPrices.set('spot', response.data);
            this.emit('price-update', response.data);
        });

        this.socket.on("new-trade", (response) => {
            this.emit('new-trade', response.data);
        });

        this.socket.on("price-change", (response) => {
            if (response.data && response.data.m) {
                this.lastPrices.set(response.data.m, response.data);
            }
            this.emit('price-change', response.data);
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
