import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { coinDCXSocket } from './CoinDCXSocketService.js';
import { DEFAULT_PAIR, DEFAULT_RESOLUTION, COINDCX_URL } from '../config/constants.js';
import { strategies } from '../strategies/index.js';
import axios from 'axios';
import dayjs from 'dayjs';
import type { Candle, Trade } from '../types/index.js';

import { SettingsService } from './SettingsService.js';
import { TradeService } from './TradeService.js';
import { CoinDCXApiService } from './CoinDCXApiService.js';
import { PaperTradeService } from './PaperTradeService.js';
import { OpeningBreakoutStrategy } from '../strategies/OpeningBreakoutStrategy.js';
import { calculateTradeProfit } from '../strategies/StrategyUtils.js';

export class SocketService {
    private static io: SocketIOServer;
    private static lastCandleTime: number | null = null;
    private static lastKnownSL: number | null = null;
    private static candles: Candle[] = []; // Cache for candlestick data
    private static lastPair: string = ''; // Track pair changes for cache invalidation
    private static lastResolution: string = ''; // Track resolution changes
    private static lastKnownSLHigh: number | null = null;
    private static lastKnownSLLow: number | null = null;
    private static currentPosition: any = null;
    static init(server: HTTPServer) {
        this.io = new SocketIOServer(server, { cors: { origin: '*' } });
        const settings = SettingsService.getSettings();

        this.io.on('connection', (socket) => {
            console.log('Frontend connected:', socket.id);
            socket.on('subscribe', (pair: string) => {
                const s = SettingsService.getSettings();
                const channel = this.formatChannel(pair || s.pair, s.timeInterval);
                console.log(`Subscribing to: ${channel}`);
                coinDCXSocket.subscribe(channel);
            });
        });

        this.setupCoinDCXListeners();
        coinDCXSocket.connect();
        
        coinDCXSocket.once('connected', () => {
            const s = SettingsService.getSettings();
            const channel = this.formatChannel(s.pair, s.timeInterval);
            console.log(`Subscribing to default channel from settings: ${channel}`);
            coinDCXSocket.subscribe(channel);
        });
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}m-futures`;
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data: Candle) => {
            const settings = SettingsService.getSettings();
            
            // Synchronize internal candle buffer
            if (this.lastPair !== settings.pair || this.lastResolution !== settings.timeInterval) {
                this.candles = [];
                this.lastPair = settings.pair;
                this.lastResolution = settings.timeInterval;
                this.lastKnownSLHigh = null;
                this.lastKnownSLLow = null;
            }

            const existingIdx = this.candles.findIndex(c => c.time === data.time);
            if (existingIdx !== -1) {
                this.candles[existingIdx] = data; // Update current tick
            } else {
                this.candles.push(data); // New candle started
                if (this.candles.length > 1000) this.candles.shift();
            }

            this.io.emit('candlestick', data);
            this.io.emit('price-change', { m: settings.pair, p: data.close });

            // 1. Real-time Monitoring (Check SL hit on every tick)
            if (settings.isLiveMonitoring) {
                this.monitorRealTimeSL(data);
            }

            if (this.lastCandleTime !== null && data.time > this.lastCandleTime && settings.isLiveMonitoring ) {
                console.log(`✅ Candle Closed at ${new Date(this.lastCandleTime).toISOString()}. Running strategies...`);
                await this.executeLiveStrategy();
            }
            this.lastCandleTime = data.time;
        });

        coinDCXSocket.on('df-position-update', (positions: any[]) => {
            const settings = SettingsService.getSettings();
            const pair = settings.pair;
            const pos = Array.isArray(positions) ? positions.find((p: any) => p.pair === pair) : null;

            if (!pos || pos.active_pos === 0) {
                this.currentPosition = null;
            } else {
                this.currentPosition = pos;
            }
            console.log(`[Socket Service] Real-time position update for ${pair}:`, this.currentPosition ? 'ACTIVE' : 'NONE');
        });
    }

    private static async executeLiveStrategy() {
        try {
            const settings = SettingsService.getSettings();
            if (!settings.isLiveMonitoring) {
                return;
            }

            const { pair, initialCapital, leverage, selectedStrategyId } = settings;
            const todayStart = Math.floor(dayjs().tz('Asia/Kolkata').startOf('day').valueOf() / 1000);
            const from = todayStart - (24 * 60 * 60); // Fetch 24h history for indicator stability
            // Fetch history only if cache is empty or for a different pair
            if (this.candles.length < 10) {
                console.log(`[Autonomous] Fetching historical candles for ${pair} (Interval: ${settings.timeInterval})...`);
                const now = Math.floor(Date.now() / 1000);
                const response = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from,
                    to: now,
                    resolution: settings.timeInterval
                });
                
                if (response.s === 'ok' && Array.isArray(response.data)) {
                    this.candles = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                }
            }
            console.log(this.candles.length,'this.candles.length')
            if (this.candles.length > 0) {
                const strategy = strategies[selectedStrategyId as keyof typeof strategies] as any;

                if (strategy) {
                    const lastCandle = this.candles[this.candles.length - 1]!;
                    // 1. Manage Active Positions (Trailing SL)
                    if (settings.isLiveTrading) {
                        try {
                            // Use cached position from websocket, or fallback to API
                            let pos = this.currentPosition;
                            if (!pos) {
                                console.log("[Autonomous] No cached position, fetching from API...");
                                const positions = await TradeService.getPositions();
                                if (positions === null) {
                                    console.log("Skipping trade due to API failure");
                                    return;
                                }
                                pos = Array.isArray(positions) ? positions.find((p: any) => p.pair === pair) : null;
                                this.currentPosition = pos;
                            }
                            
                            if (pos && pos.id) {
                                // Create a temporary trade object to use the reusable function
                                const tempTrade: Trade = {
                                    direction: pos.side.toLowerCase() === 'buy' ? 'buy' : 'sell',
                                    entryPrice: Number(pos.entry_price),
                                    sl: Number(pos.stop_loss_price),
                                    lastHigh: this.lastKnownSLHigh || Number(pos.entry_price),
                                    lastLow: this.lastKnownSLLow || Number(pos.entry_price),
                                    status: 'open',
                                    profit: 0,
                                    entryTime: ''
                                };

                                // Call the reusable static function
                                OpeningBreakoutStrategy.updateTrailingSL(tempTrade, lastCandle);

                                if (tempTrade.sl !== Number(pos.stop_loss_price)) {
                                    console.log(`[Autonomous] Trailing SL moved to ${tempTrade.sl}. Updating exchange...`);
                                    await TradeService.updatePositionTPSL({
                                        positionId: pos.id,
                                        stopLossPrice: tempTrade.sl
                                    });
                                    this.lastKnownSLHigh = tempTrade.lastHigh || null;
                                    this.lastKnownSLLow = tempTrade.lastLow || null;
                                }
                                return; // Already in trade, don't check for new signal
                            }
                        } catch (err: any) {
                            console.error("Failed to update trailing SL on exchange:", err.message);
                        }
                    }

                    // 1.5 Manage Active Paper Trades (Trailing SL update only)
                    if (settings.isPaperTrading) {
                        const activePaperTrade = PaperTradeService.getActiveTrade();
                        if (activePaperTrade) {
                            OpeningBreakoutStrategy.updateTrailingSL(activePaperTrade, lastCandle);
                            PaperTradeService.saveTrade(activePaperTrade);
                            this.io.emit('paper-trade-update', activePaperTrade);
                            return; // Still in paper trade, don't check for new signal
                        }
                    }

                    // 2. Check for New Signal if not in position
                    const result = strategy.run(this.candles, {
                        type: 'live',
                        capital: initialCapital, 
                        leverage: leverage, 
                        atrMultiplierSL: 1, 
                        simulationStartUnix: from
                    });

                    // matched is true next is for execute trade logic
                    if ('matched' in result && result.matched && result.trade) {
                        const latest = result.trade;
                        
                        console.log("🚀 NEW STRATEGY SIGNAL:", latest);
                        this.io.emit('strategy-signal', { pair, trade: latest });
                        
                        // Handle Paper Trade Entry
                        if (settings.isPaperTrading) {
                            latest.type = 'auto';
                            PaperTradeService.saveTrade(latest);
                            console.log("📄 New Paper Trade Opened:", latest);
                        }
                        
                        // Handle Real Trade Entry
                        if (settings.isLiveTrading) {
                            await TradeService.executeFutureOrder({
                                ...latest,
                                stop_loss_price: latest.sl
                            });
                            this.lastKnownSLHigh = latest.lastHigh || latest.entryPrice;
                            this.lastKnownSLLow = latest.lastLow || latest.entryPrice;
                        }
                    }
                }
            }
        } catch (err: any) {
            console.error("Autonomous strategy failed:", err.message);
        }
    }

    private static monitorRealTimeSL(tick: Candle) {
        try {
            const settings = SettingsService.getSettings();
            if (settings.isPaperTrading) {
                const activePaperTrade = PaperTradeService.getActiveTrade();
                if (activePaperTrade && activePaperTrade.status === 'open') {
                    let exited = false;
                    const currentPrice = tick.close;
                    
                    if (activePaperTrade.direction === 'buy') {
                        if (activePaperTrade.sl !== undefined && currentPrice <= activePaperTrade.sl) {
                            activePaperTrade.exitPrice = activePaperTrade.sl;
                            exited = true;
                        }
                    } else {
                        if (activePaperTrade.sl !== undefined && currentPrice >= activePaperTrade.sl) {
                            activePaperTrade.exitPrice = activePaperTrade.sl;
                            exited = true;
                        }
                    }

                    if (exited) {
                        activePaperTrade.status = 'closed';
                        activePaperTrade.exitTime = new Date().toISOString();
                        activePaperTrade.exitReason = 'SL Hit (Real-time Tick)';
                        const { profit, fee } = calculateTradeProfit(activePaperTrade, activePaperTrade.exitPrice!, 0.0002);
                        activePaperTrade.profit = profit;
                        activePaperTrade.fee = fee;
                        console.log(`📄 Real-time Paper Trade Closed at ${currentPrice}:`, activePaperTrade);
                        
                        PaperTradeService.saveTrade(activePaperTrade);
                        this.io.emit('paper-trade-update', activePaperTrade);
                    }
                }
            }
        } catch (err: any) {
            console.error("Monitor real-time SL failed:", err.message);
        }
    }
}
