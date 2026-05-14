import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { coinDCXSocket } from './CoinDCXSocketService.js';
import { DEFAULT_RESOLUTION } from '../config/constants.js';
import { strategies } from '../strategies/index.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
import type { Candle, Position, Trade } from '../types/index.js';

import { SettingsService } from './SettingsService.js';
import { TradeService } from './TradeService.js';
import { CoinDCXApiService } from './CoinDCXApiService.js';
import { TradeHistoryService } from './TradeHistoryService.js';
import { OpeningBreakoutStrategy } from '../strategies/OpeningBreakoutStrategy.js';
import { calculateTradeProfit } from '../strategies/StrategyUtils.js';
import { PriceStore } from './PriceStore.js';
import { LiveConfigService } from './LiveConfigService.js';
import { TpGoldOpeningBreakout } from '../strategies/TpGoldOpeningBreakout.js';
import { LoggerService } from './LoggerService.js';

interface LiveState {
    config: any;
    activeTrade: Trade | null;
    currentPosition: Position | null;
    isStrategyRunning: boolean;
    isPlacingOrder: boolean;
    isClosingPosition: boolean;
    lastProcessedCandleTime: number | null;
    lastSignalTime: number | null;
}

export class SocketService {
    private static io: SocketIOServer;
    private static configStates = new Map<string, LiveState>();
    private static marketRegistry = new Map<string, { candles: Candle[], candleIndexMap: Map<number, number> }>();
    private static channelConfigs = new Map<string, Set<string>>(); // channel -> Set of configIds

    static emitSystemLog(log: any) {
        if (this.io) {
            this.io.emit('system_log', log);
        }
    }

    static async init(server: HTTPServer) {
        this.io = new SocketIOServer(server, { 
            cors: { origin: '*', methods: ["GET", "POST"] },
            transports: ["websocket"],
            pingInterval: 25000,
            pingTimeout: 60000,
        });

        // Register this socket service as the broadcaster for LoggerService
        LoggerService.setBroadcaster((log) => this.emitSystemLog(log));

        this.io.on('connection', (socket) => {
            console.log('Frontend connected:', socket.id);
            socket.on('subscribe', (pair: string) => {
                if (pair) {
                    const channel = this.formatChannel(pair, '1');
                    console.log(`Subscribing to: ${channel}`);
                    coinDCXSocket.subscribe(channel);
                }
            });
        });

        this.setupCoinDCXListeners();
        coinDCXSocket.connect();
        
        // Initialize enabled configurations from DB
        try {
            const configs = await LiveConfigService.getEnabledConfigs();
            console.log(`[Lifecycle] 🚀 Initializing ${configs.length} enabled configurations...`);
            
            for (const config of configs) {
                await this.addConfigState(config);
            }
        } catch (err: any) {
            console.error('[Lifecycle] ❌ Failed to load configs:', err.message);
        }

        coinDCXSocket.on('connected', () => {
            console.log(`[Self-Healing] 🔄 Socket reconnected. Synchronizing all channels...`);
            for (const [channel] of this.marketRegistry.entries()) {
                coinDCXSocket.subscribe(channel);
            }
        });

        this.startMemorySync();
    }

    public static async initializeConfig(configId: string) {
        const config = await LiveConfigService.getConfig(configId);
        if (config) {
            await this.addConfigState(config);
        }
    }

    private static async addConfigState(config: any) {
        const id = config._id.toString();
        const channel = this.formatChannel(config.pair, config.timeInterval);
        const tickerChannel = this.formatChannel(config.pair, '1');

        // Route channels to this config
        if (!this.channelConfigs.has(channel)) this.channelConfigs.set(channel, new Set());
        this.channelConfigs.get(channel)!.add(id);
        
        if (!this.channelConfigs.has(tickerChannel)) this.channelConfigs.set(tickerChannel, new Set());
        this.channelConfigs.get(tickerChannel)!.add(id);

        // Initialize registry buffer if new
        if (!this.marketRegistry.has(channel)) {
            this.marketRegistry.set(channel, { candles: [], candleIndexMap: new Map() });
            // Prime history immediately for this pair
            await this.primeHistory(config.pair, config.timeInterval);
        }

        // Fetch active trade status
        const activeTrade = await TradeHistoryService.getActiveTrade(id);

        this.configStates.set(id, {
            config,
            activeTrade: activeTrade as any,
            currentPosition: null,
            isStrategyRunning: false,
            isPlacingOrder: false,
            isClosingPosition: false,
            lastProcessedCandleTime: null,
            lastSignalTime: null
        });

        console.log(`[Lifecycle] ✅ Loaded ${config.pair} [${config.strategyId}] (Active: ${!!activeTrade})`);
        
        if (coinDCXSocket.isConnected?.()) {
            coinDCXSocket.subscribe(channel);
            coinDCXSocket.subscribe(tickerChannel);
        }
    }

    public static async removeConfigState(configId: string) {
        const state = this.configStates.get(configId);
        if (!state) return;

        const config = state.config;
        const channel = this.formatChannel(config.pair, config.timeInterval);
        const tickerChannel = this.formatChannel(config.pair, '1');

        // Remove from channelConfigs mapping
        if (this.channelConfigs.has(channel)) {
            this.channelConfigs.get(channel)!.delete(configId);
            if (this.channelConfigs.get(channel)!.size === 0) {
                this.channelConfigs.delete(channel);
                this.marketRegistry.delete(channel);
                coinDCXSocket.unsubscribe(channel);
                console.log(`[Lifecycle] 📡 Unsubscribed from channel: ${channel}`);
            }
        }

        if (this.channelConfigs.has(tickerChannel)) {
            this.channelConfigs.get(tickerChannel)!.delete(configId);
            if (this.channelConfigs.get(tickerChannel)!.size === 0) {
                this.channelConfigs.delete(tickerChannel);
                coinDCXSocket.unsubscribe(tickerChannel);
                console.log(`[Lifecycle] 📡 Unsubscribed from ticker channel: ${tickerChannel}`);
            }
        }

        this.configStates.delete(configId);
        console.log(`[Lifecycle] 🗑️ Removed config state for ${config.pair} [${configId}]`);
    }

    private static async primeHistory(pair: string, interval: string) {
        try {
            const channel = this.formatChannel(pair, interval);
            const from = Math.floor(Date.now() / 1000) - 86400; // 24 hours
            const response = await CoinDCXApiService.getCandlesticks({
                pair, from, to: Math.floor(Date.now() / 1000), resolution: interval
            });
            if (response.s === 'ok' && Array.isArray(response.data)) {
                const candles = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                const registry = this.marketRegistry.get(channel)!;
                registry.candles = candles;
                registry.candleIndexMap.clear();
                candles.forEach((c: Candle, i: number) => registry.candleIndexMap.set(c.time, i));
                console.log(`[Sync] 📥 Primed ${candles.length} candles for ${channel}`);
            }
        } catch (err: any) {
            console.error(`[Sync] ❌ Failed to prime ${pair}:`, err.message);
        }
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair?.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}m-futures`;
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data: Candle) => {
            const incomingPair = (data as any).pair;
            if (!incomingPair) return;

            // Route to frontend
            this.io.emit('candlestick', data);
            this.io.emit('price-change', { m: incomingPair, p: data.close });
            PriceStore.update(incomingPair, data.close);

            const channel = this.formatChannel(incomingPair, (data as any).resolution || '1');
            const registry = this.marketRegistry.get(channel);
            if (!registry) return;

            // 1. Update Candle Buffer (O(1) logic)
            if (registry.candleIndexMap.has(data.time)) {
                const idx = registry.candleIndexMap.get(data.time)!;
                registry.candles[idx] = data;
            } else {
                const isNewCandleTrigger = registry.candles.length > 0;
                registry.candleIndexMap.set(data.time, registry.candles.length);
                registry.candles.push(data);

                if (registry.candles.length > 3000) {
                    const removed = registry.candles.shift();
                    if (removed) {
                        registry.candleIndexMap.clear();
                        registry.candles.forEach((c, i) => registry.candleIndexMap.set(c.time, i));
                    }
                }
 
                // 2. Identify and trigger all configurations using this channel
                const targetConfigs = this.channelConfigs.get(channel);
                if (targetConfigs && isNewCandleTrigger) {
                    for (const configId of targetConfigs) {
                        const state = this.configStates.get(configId);
                        if (!state) continue;

                        const closedCandle = registry.candles[registry.candles.length - 2]; // Previous candle is now closed
                        if (closedCandle && state.lastProcessedCandleTime !== closedCandle.time) {
                            state.lastProcessedCandleTime = closedCandle.time;

                            // Run Strategy Check (Interval check)
                            const interval = Number(state.config.timeInterval);
                            const currentTime = new Date(closedCandle.time);
                            if (currentTime.getMinutes() % interval === 0 && !state.isStrategyRunning) {
                                state.isStrategyRunning = true;
                                this.executeLiveStrategy(configId, state, registry.candles)
                                    .catch(err => console.error(`[Strategy] ${configId} Error:`, err.message))
                                    .finally(() => state.isStrategyRunning = false);
                            }
                        }
                    }
                }
            }

            // 3. Tick-based Real-time SL Hit & Pending Breakout Monitoring
            const tickerConfigs = this.channelConfigs.get(this.formatChannel(incomingPair, '1'));
            if (tickerConfigs) {
                for (const configId of tickerConfigs) {
                    const state = this.configStates.get(configId);
                    if (!state) continue;

                    // A. Monitor for Pending Breakouts (Gold Strategy)
                    if (state.config.strategyId === 'tp-gold-opening-breakout' && !state.activeTrade) {
                        const pbResult = TpGoldOpeningBreakout.checkPendingBreakout(data, {
                            ...state.config,
                            type: 'live',
                            capital: state.config.initialCapital || 100
                        });

                        if (pbResult.matched && pbResult.trade) {
                            console.log(`[Monitor] 🚀 BREAKOUT TRIGGERED for ${incomingPair}!`);
                            // We don't block here, just initialize the trade
                            this.handleOrderEntry(configId, state, pbResult.trade)
                                .catch(err => console.error(`[Breakout] ${configId} Order Failed:`, err.message));
                        }
                    }

                    // B. Monitor SL/TP for Active Trades
                    if (state.activeTrade?.status === 'open') {
                        this.monitorRealTimeSL(data, state).catch(err => console.error(`[Monitor] ${configId} Error:`, err.message));
                    }
                }
            }
        });






    

    coinDCXSocket.on('df-position-update', async (positions: any[]) => {
        // 📦 UNPACKING: The socket often sends data as a stringified JSON array
        let posList: any[] = [];
        try {
            const raw = Array.isArray(positions) ? positions : (positions ? [positions] : []);
            posList = raw.flatMap(item => {
                if (typeof item === 'string') {
                    try {
                        const parsed = JSON.parse(item);
                        return Array.isArray(parsed) ? parsed : [parsed];
                    } catch { return []; }
                }
                return item;
            });
        } catch (err) {}
        
        // Update all config states based on incoming positions
        for (const [id, state] of this.configStates.entries()) {
            const pair = state.config.pair;
            const wasActive = !!state.currentPosition && state.currentPosition.active_pos !== 0;
            
            const pos = posList.find((p: any) => {
                const cleanP = (p.pair || '').replace('B-', '').toLowerCase();
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                return cleanP === cleanS;
            });

            const isActive = !!pos && pos.active_pos !== 0;
            if (isActive) state.currentPosition = pos;

            if (wasActive && !isActive) {
                // Position closed on exchange
                console.log(`[Position] Trade CLOSED on exchange for ${pair}`);
                if (state.activeTrade) {
                    state.activeTrade.status = 'closed';
                    state.activeTrade.exitTime = dayjs().tz('Asia/Kolkata').format();
                    state.activeTrade.exitReason = 'Exchange Position Closed';
                    
                    // Try to get last known price for profit calculation
                    const registry = this.marketRegistry.get(this.formatChannel(pair, '1'));
                    const lastCandle = registry?.candles && registry.candles.length > 0 ? registry.candles[registry.candles.length - 1] : null;
                    const lastPrice = lastCandle ? lastCandle.close : state.activeTrade.sl;
                    
                    if (lastPrice) {
                        const { profit, fee, pnlPercent } = calculateTradeProfit(state.activeTrade, lastPrice, 0.0005);
                        state.activeTrade.profit = profit;
                        state.activeTrade.fee = fee;
                        state.activeTrade.pnlPercent = pnlPercent;
                        state.activeTrade.exitPrice = lastPrice;
                    }

                    await TradeHistoryService.saveTrade(state.activeTrade);
                    this.io.emit('trade-history-update', state.activeTrade);
                    state.activeTrade = null;
                }
                state.currentPosition = null;
            }
        }
    });
}


    private static async executeLiveStrategy(configId: string, state: LiveState, candles: Candle[]) {
        try {
            const config = state.config;
            const pair = config.pair;
            const strategy = strategies[config.strategyId as keyof typeof strategies] as any;
            
            // Check if ANY trade is open for this pair across all configurations
            const globalActiveTrade = await TradeHistoryService.getActiveTradeByPair(pair);
            if (globalActiveTrade) {
                // If the state doesn't know about it, sync it
                if (!state.activeTrade) {
                    state.activeTrade = globalActiveTrade as any;
                }
                return;
            }

            if (candles.length < 10) return;

            const latestCandle = candles[candles.length - 1];
            if (!latestCandle || state.lastSignalTime === latestCandle.time) return;

            console.log(`[Strategy] 🔍 Scanning ${pair} for '${config.strategyId}' signal...`);
            const result = strategy.run(candles, {
                pair,
                type: 'live',
                capital: config.initialCapital || 100,
                riskAmount: TradeService.TEST_RISK_AMOUNT, // Use the minimal risk for testing
                leverage: config.leverage || 10,
                maxPositionSize: config.maxPositionSize || 85,
                atrMultiplierSL: 1.0,
                simulationStartUnix: Math.floor(Date.now() / 1000) - 86400
            });
            console.log(result.matched , result.trade,'result.matched && result.trade')
               
            
            if (result.matched && result.trade) {
                    state.lastSignalTime = latestCandle?.time || 0;
                    await LoggerService.log('info', `🎯 Signal Detected: ${result.trade.direction.toUpperCase()} for ${pair}`, 'SocketService', { configId, pair, metadata: result.trade });
                    await this.handleOrderEntry(configId, state, result.trade);
                }
            } catch (err: any) {
            await LoggerService.log('error', `Routine failed: ${err.message}`, 'SocketService', { pair: 'SYSTEM' });
            }
    }

    private static async handleOrderEntry(configId: string, state: LiveState, trade: Trade) {
        const config = state.config;
        const pair = config.pair;      
        console.log(config,'config.autoTrade--------')
        console.log(state.isPlacingOrder,'state.isPlacingOrder-------')
        if (config.autoTrade) {
            if (state.isPlacingOrder) return;
            state.isPlacingOrder = true;
            try {
                await LoggerService.log('info', `🚀 Executing REAL entry for ${pair}...`, 'SocketService', { configId, pair });
                await TradeService.executeFutureOrder({ 
                    ...trade, 
                    leverage: config.leverage,
                    maxPositionSize: (config as any).maxPositionSize,
                    stop_loss_price: trade.sl 
                } as any);
                
                // Wait for exchange state to update
                await new Promise(res => setTimeout(res, 1500));
 
                const savedTrade = await TradeHistoryService.saveTrade({
                    ...trade,
                    pair,
                    configId,
                    strategyId: config.strategyId,
                    status: 'open',
                    type: 'real',
                    leverage: config.leverage,
                    maxPositionSize: (config as any).maxPositionSize,
                    entryTime: dayjs().tz('Asia/Kolkata').format()
                } as any);
                state.activeTrade = savedTrade as any;
                await LoggerService.log('success', `✅ REAL Position Opened for ${pair}`, 'SocketService', { configId, pair, metadata: savedTrade });
            } catch (err: any) {
                await LoggerService.log('error', `❌ REAL Execution Failed for ${pair}: ${err.message}`, 'SocketService', { configId, pair });
                throw err;
            } finally {
                state.isPlacingOrder = false;
            }
        } else {
            // PAPER TRADE
            const savedTrade = await TradeHistoryService.saveTrade({
                ...trade,
                pair,
                configId,
                strategyId: config.strategyId,
                leverage: config.leverage,
                status: 'open',
                type: 'paper',
                entryTime: dayjs().tz('Asia/Kolkata').format()
            });
            state.activeTrade = savedTrade as any;
            await LoggerService.log('info', `🏁 Paper Trade Initialized for ${pair}`, 'SocketService', { configId, pair, metadata: savedTrade });
            this.io.emit('trade-history-update', state.activeTrade);
        }
    }

    private static async monitorRealTimeSL(tick: Candle, state: LiveState) {
        try {
            const activeTrade = state.activeTrade;
            if (!activeTrade || activeTrade.status !== 'open') return;

            const currentPrice = tick.close;
            const high = tick.high || currentPrice;
            const low = tick.low || currentPrice;

            const sl = activeTrade.sl || activeTrade.stop_loss_price || 0;
            const tp = activeTrade.tp || activeTrade.take_profit_price || 0;
            const isBuy = activeTrade.direction === 'buy';

            let exitHit = false;
            let reason = '';

            if (isBuy) {
                // For LONG: SL is hit if LOW touches SL price. TP is hit if HIGH touches TP price.
                if (sl > 0 && low <= sl) { exitHit = true; reason = 'SL Hit'; }
                else if (tp > 0 && high >= tp) { exitHit = true; reason = 'TP Hit'; }
            } else {
                // For SHORT: SL is hit if HIGH touches SL price. TP is hit if LOW touches TP price.
                if (sl > 0 && high >= sl) { exitHit = true; reason = 'SL Hit'; }
                else if (tp > 0 && low <= tp) { exitHit = true; reason = 'TP Hit'; }
            }

            if (exitHit) {
                if (activeTrade.type === 'real' && !state.isClosingPosition) {
                    await LoggerService.log('warning', `🎯 REAL ${reason} Triggered for ${activeTrade.pair} at ${currentPrice}. Closing position...`, 'SocketService', { configId: activeTrade.configId || '', pair: activeTrade.pair || '' });
                    state.isClosingPosition = true;
                    try {
                        const pos = state.currentPosition;
                        if (pos) {
                            await TradeService.closePosition({ positionId: pos.id });
                            
                            // Update trade record with exit data
                            activeTrade.status = 'closed';
                            activeTrade.exitPrice = currentPrice;
                            activeTrade.exitTime = dayjs().tz('Asia/Kolkata').format();
                            activeTrade.exitReason = `REAL ${reason}`;
                            
                            // Use position quantity from exchange if units are missing in trade record
                            if (!activeTrade.units && pos.active_pos) {
                                activeTrade.units = Math.abs(pos.active_pos);
                            }

                            const { profit, fee, pnlPercent } = calculateTradeProfit(activeTrade, currentPrice, 0.0005);
                            activeTrade.profit = profit;
                            activeTrade.fee = fee;
                            activeTrade.pnlPercent = pnlPercent;
                            
                            console.log(`[SL-Monitor] Profit Calc: Entry=${activeTrade.entryPrice}, Exit=${currentPrice}, Units=${activeTrade.units}, Direction=${activeTrade.direction}, Profit=${profit}, PnL%=${pnlPercent}`);
                            
                            await TradeHistoryService.saveTrade(activeTrade);
                            state.activeTrade = null;
                            state.currentPosition = null;
                            this.io.emit('trade-history-update', activeTrade);

                            await LoggerService.log('success', `✅ REAL Position Closed (${reason}) for ${activeTrade.pair} | PnL: ${profit.toFixed(4)}`, 'SocketService', { configId: activeTrade.configId || '', pair: activeTrade.pair || '' });
                        }
                    } catch (err: any) {
                        await LoggerService.log('error', `❌ Real Exit Failed for ${activeTrade.pair}: ${err.message}`, 'SocketService', { configId: activeTrade.configId || '', pair: activeTrade.pair || '' });
                    }
                } else if (activeTrade.type !== 'real') {
                    activeTrade.status = 'closed';
                    const targetPrice = reason === 'SL Hit' ? sl : tp;
                    activeTrade.exitPrice = targetPrice;
                    activeTrade.exitTime = dayjs().tz('Asia/Kolkata').format();
                    activeTrade.exitReason = `Ticket ${reason}`;
                    
                    const { profit, fee } = calculateTradeProfit(activeTrade, targetPrice, 0.0005);
                    activeTrade.profit = profit;
                    activeTrade.fee = fee;
                    
                    await TradeHistoryService.saveTrade(activeTrade);
                    state.activeTrade = null;
                    this.io.emit('trade-history-update', activeTrade);
                    console.log(`[Monitor] 🎯 ${activeTrade.type?.toUpperCase() || 'REAL'} ${reason} for ${activeTrade.pair}.`);
                }
            }
        } catch (err: any) {
            console.error("Monitor status failed:", err.message);
        }
    }

    /**
     * ⚡ IMMEDIATE SYNC: Forces the engine to reload trade state for a specific config.
     * Used by TradeController when manual changes occur.
     */
    public static async syncActiveTrade(configId: string) {
        try {
            const state = this.configStates.get(configId);
            if (!state) return;

            const activeTrade = await TradeHistoryService.getActiveTrade(configId);
            state.activeTrade = activeTrade as any;
            console.log(`[Sync] ⚡ Immediate sync triggered for ${state.config.pair}. Trade: ${!!activeTrade}`);
        } catch (err: any) {
            console.error(`[Sync] ❌ Sync failed for ${configId}:`, err.message);
        }
    }

    /**
     * 🔄 BACKGROUND SYNC: Periodically reloads all open trades from DB for all pairs.
     */
    private static startMemorySync() {
        setInterval(async () => {
            try {
                for (const [id, state] of this.configStates.entries()) {
                    // 1. Sync Existing Trades (SL/TP changes)
                    if (state.activeTrade && state.activeTrade.status === 'open') {
                        const updated = await TradeHistoryService.findTradeByTime(state.activeTrade.entryTime);
                        if (!updated || updated.status === 'closed') {
                            console.log(`[Sync] 💨 Trade for ${state.config.pair} closed externally.`);
                            state.activeTrade = null;
                        } else if (updated.sl !== state.activeTrade.sl || updated.tp !== state.activeTrade.tp) {
                            state.activeTrade = updated as any;
                            console.log(`[Sync] 🔄 SL/TP Update detected for ${state.config.pair}.`);
                        }
                    } 
                    // 2. Detect New Manual Trades
                    else if (!state.activeTrade) {
                        const manualTrade = await TradeHistoryService.getActiveTrade(id);
                        if (manualTrade) {
                            state.activeTrade = manualTrade as any;
                            console.log(`[Sync] 🎯 New manual trade detected for ${state.config.pair}. Monitoring started.`);
                        }
                    }
                }
            } catch (err) {}
        }, 10000); // 10s sync window
    }

    /**
     * Reconstructs the current day's trade history (from 00:00) 
     * by running a dedicated backtest on the strategy.
     */
    /**
     * 🔄 MULTI-PAIR RECOVERY: Reconstructs today's history for all enabled pairs.
     */
    static async recoverTodayTrades() {
        try {
            console.log(`[Recovery] 🔄 Starting multi-pair history reconstruction...`);
            
            for (const [id, state] of this.configStates.entries()) {
                const config = state.config;
                const pair = config.pair;
                const resolution = config.timeInterval;
                
                const todayKolkata = dayjs().tz('Asia/Kolkata').startOf('day');
                const startOfDay = todayKolkata.valueOf();
                const from = Math.floor((startOfDay - (12 * 60 * 60 * 1000)) / 1000); 
                const to = Math.floor(Date.now() / 1000);

                console.log(`[Recovery] 🔄 Processing ${pair} (${resolution}m)...`);

                const response = await CoinDCXApiService.getCandlesticks({ pair, from, to, resolution });
                if (response.s !== 'ok' || !Array.isArray(response.data)) continue;

                const candles = response.data.sort((a: any, b: any) => a.time - b.time);
                let subCandles: Candle[] = [];
                if (resolution !== '1') {
                    const subRes = await CoinDCXApiService.getCandlesticks({ pair, from, to, resolution: '1' });
                    if (subRes.s === 'ok' && Array.isArray(subRes.data)) {
                        subCandles = subRes.data.sort((a: any, b: any) => a.time - b.time);
                    }
                }

                const strategy = strategies[config.strategyId as keyof typeof strategies] as any;
                if (!strategy) continue;

                const result = strategy.run(candles, {
                    type: 'backtest',
                    pair: pair,
                    capital: config.initialCapital,
                    leverage: config.leverage,
                    trailingSL: true,
                    atrMultiplierSL: 1.0, 
                    simulationStartUnix: Math.floor(startOfDay / 1000) 
                }, subCandles);

                if (result && result.trades) {
                    for (const t of result.trades) {
                        const overlap = await TradeHistoryService.findOverlap(pair, t.entryTime);
                        if (!overlap) {
                            await TradeHistoryService.saveTrade({ ...t, pair, configId: id, type: 'recovery', status: 'closed' });
                        }
                    }
                }

                if (result && result.activeTrade && !state.activeTrade) {
                    const overlap = await TradeHistoryService.findOverlap(pair, result.activeTrade.entryTime);
                    if (!overlap) {
                        const saved = await TradeHistoryService.saveTrade({ ...result.activeTrade, pair, configId: id, type: 'recovery', status: 'open' });
                        state.activeTrade = saved as any;
                    }
                }
            }
            console.log(`[Recovery] ✅ Multi-pair history reconstruction complete.`);
        } catch (err: any) {
            console.error('[Recovery] ❌ Recovery failed:', err.message);
        }
    }
}
