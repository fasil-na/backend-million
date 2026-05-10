import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { coinDCXSocket } from './CoinDCXSocketService.js';
import { DEFAULT_RESOLUTION } from '../config/constants.js';
import { strategies } from '../strategies/index.js';
import dayjs from 'dayjs';
import type { Candle, Position, Trade } from '../types/index.js';

import { SettingsService } from './SettingsService.js';
import { TradeService } from './TradeService.js';
import { CoinDCXApiService } from './CoinDCXApiService.js';
import { TradeHistoryService } from './TradeHistoryService.js';
import { OpeningBreakoutStrategy } from '../strategies/OpeningBreakoutStrategy.js';
import { calculateTradeProfit } from '../strategies/StrategyUtils.js';
import { PriceStore } from './PriceStore.js';
import { SystemLogService } from './SystemLogService.js';
import mongoose from 'mongoose';
import { LiveConfigService } from './LiveConfigService.js';
import type { ILiveConfig } from '../models/LiveConfig.js';

interface LiveState {
    config: any;
    currentPosition: Position | null;
    activeTrade: Trade | null;
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
    private static channelConfigs = new Map<string, Set<string>>();
    private static pairConfigs = new Map<string, Set<string>>();

    public static getIO() {
        return SocketService.io;
    }


    static async init(server: HTTPServer) {
        SocketService.io = new SocketIOServer(server, {
            cors: {
                origin: '*',
                methods: ["GET", "POST"]
            },
            transports: ["websocket"],
            pingInterval: 25000,
            pingTimeout: 60000,
        });

        SocketService.io.on('connection', (socket) => {
            console.log('Frontend connected:', socket.id);
            socket.on('subscribe', (pair: string) => {
                if (pair) {
                    const channel = SocketService.formatChannel(pair, '1');
                    console.log(`Subscribing to: ${channel}`);
                    coinDCXSocket.subscribe(channel);
                }
            });
        });

        SocketService.setupCoinDCXListeners();
        coinDCXSocket.connect();

        // Initialize enabled configurations
        try {
            const configs = await LiveConfigService.getEnabledConfigs();
            console.log(`[Lifecycle] 🚀 Found ${configs.length} enabled live configurations.`);
            for (const config of configs) {
                SocketService.addConfigState(config);
            }
        } catch (err: any) {
            console.error('[Lifecycle] ❌ Failed to load live configs:', err.message);
        }

        coinDCXSocket.on('connected', () => {
            // Subscriptions for all active configs
            for (const state of SocketService.configStates.values()) {
                coinDCXSocket.subscribe(SocketService.formatChannel(state.config.pair, state.config.timeInterval));
                coinDCXSocket.subscribe(SocketService.formatChannel(state.config.pair, '1'));
            }

            console.log(`[Self-Healing] 🔄 Socket reconnected. Synchronizing state...`);
            SocketService.syncExchangeState().catch(err => console.error('[Sync] ❌ Recovery Failed:', err.message));
        });
    }

    private static addConfigState(config: any) {
        const id = config._id.toString();
        if (SocketService.configStates.has(id)) return;

        // Normalization
        const normalizedPair = (config.pair || '').replace('B-', '').replace('_', '').toUpperCase();
        const channel = SocketService.formatChannel(config.pair, config.timeInterval);
        const tickerChannel = SocketService.formatChannel(config.pair, '1');

        // Map config to channels and pairs
        if (!SocketService.channelConfigs.has(channel)) SocketService.channelConfigs.set(channel, new Set());
        SocketService.channelConfigs.get(channel)!.add(id);

        if (!SocketService.channelConfigs.has(tickerChannel)) SocketService.channelConfigs.set(tickerChannel, new Set());
        SocketService.channelConfigs.get(tickerChannel)!.add(id);

        if (!SocketService.pairConfigs.has(normalizedPair)) SocketService.pairConfigs.set(normalizedPair, new Set());
        SocketService.pairConfigs.get(normalizedPair)!.add(id);

        // Initialize shared buffer if needed
        if (!SocketService.marketRegistry.has(channel)) {
            SocketService.marketRegistry.set(channel, { candles: [], candleIndexMap: new Map() });
        }

        SocketService.configStates.set(id, {
            config,
            currentPosition: null,
            activeTrade: null,
            isStrategyRunning: false,
            isPlacingOrder: false,
            isClosingPosition: false,
            lastProcessedCandleTime: null,
            lastSignalTime: null
        });
        console.log(`[Lifecycle] ✅ Initialized state for config: ${config.strategyId} on ${config.pair}`);
        
        // Subscribe if socket is already connected
        if (coinDCXSocket.isConnected?.()) {
            coinDCXSocket.subscribe(SocketService.formatChannel(config.pair, config.timeInterval));
            coinDCXSocket.subscribe(SocketService.formatChannel(config.pair, '1'));
        }
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}m-futures`;
    }

    /**
     * 🛡️ SELF-HEALING: Synchronizes the local bot state with the exchange reality.
     * Prevents the bot from getting stuck in "Open" if a trade closed while server was away.
     */
    private static async syncPositionsWithExchange() {
        try {
            const positions = await TradeService.getPositions();
            console.log(`[Sync] 🔍 Checking exchange status for ${SocketService.configStates.size} configs...`);

            for (const [id, state] of SocketService.configStates.entries()) {
                const pair = state.config.pair;
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                const livePos = Array.isArray(positions)
                    ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                    : null;

                if (livePos) {
                    state.currentPosition = livePos;
                    console.log(`[Sync] ✅ Active position found for ${id} on ${pair}`);
                } else {
                    state.currentPosition = null;
                }
            }
        } catch (err: any) {
            console.error('[Sync] Failed to synchronize state:', err.message);
        }
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data: Candle) => {
            try {
                const channel = (data as any).channel || SocketService.formatChannel((data as any).pair, (data as any).resolution || '1');
              
                if (!channel) return;

                const incomingPair = (data as any).pair;
                if (incomingPair) {
                    PriceStore.update(incomingPair, data.close);
                    SocketService.io.emit('price-change', { m: incomingPair, p: data.close });
                }
                SocketService.io.emit('candlestick', data);

                const configIds = SocketService.channelConfigs.get(channel);
                if (!configIds) return;

                // 1. Update SHARED buffer for this channel
                let registry = SocketService.marketRegistry.get(channel);
                if (!registry) {
                    registry = { candles: [], candleIndexMap: new Map() };
                    SocketService.marketRegistry.set(channel, registry);
                }

                const { candles, candleIndexMap } = registry;
                let isNewCandleTrigger = false;

                if (candleIndexMap.has(data.time)) {
                    candles[candleIndexMap.get(data.time)!] = data;
                } else {
                    isNewCandleTrigger = candles.length > 0;
                    candleIndexMap.set(data.time, candles.length);
                    candles.push(data);

                    if (candles.length > 3000) {
                        candles.shift();
                        candleIndexMap.clear();
                        candles.forEach((c, i) => candleIndexMap.set(c.time, i));
                    }
                }

                const closedCandle = isNewCandleTrigger ? candles[candles.length - 2] : null;

                // 2. Process all relevant configs for this channel
                for (const id of configIds) {
                    const state = SocketService.configStates.get(id);
                    if (!state) continue;
                    const config = state.config;
                    const strategy = (strategies as any)[config.strategyId];
                    if (!strategy) continue;

                    // A. Monitor Real-time SL/TP for open trades (always on every tick)
                    if (state.activeTrade && state.activeTrade.status === 'open') {
                        SocketService.monitorRealTimeSL(data, id, state).catch(err => console.error(`[Monitor] ❌ ${id} Error:`, err.message));
                    }

                    // B. Real-time Strategy Signal (Check every tick if strategy supports it)
                    // This replaces the hardcoded Gold breakout logic
                    const tickCheck = strategy.checkTickSignal || (strategy.constructor as any)?.checkTickSignal;
                    if (tickCheck) {
                        try {
                            const result = tickCheck(data, config, state);
                            if (result && result.matched && result.trade) {
                                SystemLogService.log('INFO', 'STRATEGY', `🚀 Tick Signal Triggered for ${id} (${config.strategyId})!`);
                                SocketService.executeSignal(result.trade, id, state).catch(err => {
                                    SystemLogService.log('ERROR', 'EXECUTION', `Failed to execute tick signal for ${id}: ${err.message}`);
                                });
                            }
                        } catch (err: any) {
                            console.error(`[TickCheck] ❌ ${config.strategyId} error:`, err.message);
                        }
                    }

                    // C. Main Strategy Logic (on candle close of config resolution)
                    if (isNewCandleTrigger) {
                         const intervalMinutes = Number(config.timeInterval || '1');
                         const isIntervalMatch = (config.timeInterval === '1') || 
                                               (closedCandle && new Date(closedCandle.time).getMinutes() % intervalMinutes === 0);

                         if (isIntervalMatch) {
                            if (!state.isStrategyRunning) {
                                state.isStrategyRunning = true;
                                SocketService.executeLiveStrategy(id, state, candles)
                                    .catch(err => SystemLogService.log('ERROR', 'STRATEGY', `Scan failed for ${id}: ${err.message}`))
                                    .finally(() => state.isStrategyRunning = false);
                            }
                         }
                    }
                }
            } catch (err: any) {
                console.error('[Candlestick] ❌ Listener Critical Error:', err.message);
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
            } catch (err: any) {
                console.error("[Position] ❌ Unpacking failed:", err);
            }

            // Sync all configs
            for (const [id, state] of SocketService.configStates.entries()) {
                const config = state.config;
                const pair = config.pair;
                const wasActive = !!state.currentPosition && state.currentPosition.active_pos !== 0;

                const pos = posList.find((p: any) => {
                    const cleanP = (p.pair || '').replace('B-', '').toLowerCase();
                    const cleanC = (pair || '').replace('B-', '').toLowerCase();
                    return cleanP === cleanC;
                });

                let isActive = !!pos && pos.active_pos !== 0;

                if (isActive) {
                    state.currentPosition = pos;
                } else {
                    // Check for closure
                    if (wasActive) {
                        state.currentPosition = null;
                        console.log(`[Position] Trade CLOSED for ${id} on ${pair}`);
                        
                        // Record exit if needed
                        try {
                            const activeTrade = await TradeHistoryService.getActiveTrade(id);
                            if (activeTrade && activeTrade.status === 'open') {
                                const channel = SocketService.formatChannel(pair, config.timeInterval);
                                const registry = SocketService.marketRegistry.get(channel);
                                const lastCandle = registry?.candles && registry.candles.length > 0 
                                    ? registry.candles[registry.candles.length - 1] 
                                    : null;
                                const exitPrice = lastCandle ? lastCandle.close : activeTrade.entryPrice;

                                activeTrade.status = 'closed';
                                activeTrade.exitPrice = exitPrice;
                                activeTrade.exitTime = new Date().toISOString();
                                activeTrade.exitReason = 'Exchange Position Closed';

                                const { profit, fee } = calculateTradeProfit(activeTrade, exitPrice, 0.0005);
                                activeTrade.profit = profit;
                                activeTrade.fee = fee;

                                await TradeHistoryService.saveTrade(activeTrade);
                                state.activeTrade = null;
                                SocketService.io.emit('trade-history-update', activeTrade);
                            }
                        } catch (err: any) {
                            console.error(`[Position] Failed to record exit for ${id}:`, err.message);
                        }
                    }
                }
            }
        });
    }

    private static async executeLiveStrategy(configId: string, state: LiveState, sharedCandles?: Candle[]) {
        try {
            const config = state.config;
            const pair = config.pair;
            SystemLogService.log('INFO', 'STRATEGY', `🎯 SIGNAL [${configId}]: for ${pair} detected.executeLiveStrategy`);
            // 1. Fetch latest trade for THIS CONFIG to check status
            const activeTrade = state.activeTrade;
            console.log(activeTrade,'activeTrade-----')
            if (activeTrade) {
                if (activeTrade.status === 'open') return;
                state.activeTrade = null; // 🛡️ Clean up closed reference
            }

            const channel = SocketService.formatChannel(pair, config.timeInterval);
            const registry = SocketService.marketRegistry.get(channel);
            const candles = sharedCandles || registry?.candles || [];
            
            const latestCandle = candles[candles.length - 1];
            if (!latestCandle) return;
            // 🛑 GUARD: Prevent multiple entries for the same candle
            if (state.lastSignalTime === latestCandle.time) return;

            const leverage = config.leverage;
            const initialCapital = config.initialCapital;
            const from = Math.floor(Date.now() / 1000) - (7 * 86400);

            // 2. Refresh candles if buffer is missing
            if (candles.length < 10 && registry) {
                console.log(`[Strategy] 📥 Buffer low for ${configId}. Fetching history for ${pair}...`);
                const response = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from,
                    to: Math.floor(Date.now() / 1000),
                    resolution: config.timeInterval
                });
                if (response.s === 'ok' && Array.isArray(response.data)) {
                    const sorted = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                    registry.candles = sorted;
                    registry.candleIndexMap.clear();
                    sorted.forEach((c, i) => registry.candleIndexMap.set(c.time, i));
                }
            }

            if (candles.length === 0) return;

            // 3. Select Strategy
            const strategy = strategies[config.strategyId as keyof typeof strategies] as any;
            if (!strategy) return;
            // 🎯 NEW RISK LOGIC (Fallback-free):
            let liveCapital = initialCapital;
            if (config.isLiveTrading) {
                const exchangeData = TradeService.getInstrumentDetailsSync(pair);
                const minNotional = exchangeData.minNotional || 6;

                if (config.riskMode === 'capital') {
                    liveCapital = config.initialCapital || 100;
                } else {
                    const safeNotional = minNotional * 1.10;
                    liveCapital = safeNotional / leverage;
                }
            }

            // 4. Run Strategy Check
            const hasTradedToday = await TradeHistoryService.hasTradedToday(pair, config.strategyId, configId);
            const result = strategy.run(candles, {
                pair: pair,
                type: 'live',
                capital: liveCapital,
                leverage: leverage,
                atrMultiplierSL: 1,
                simulationStartUnix: from,
                hasTradedToday 
            });

            if ('matched' in result && result.matched && result.trade) {
                const latest = result.trade;
                state.lastSignalTime = latestCandle.time;
                SystemLogService.log('INFO', 'STRATEGY', `🎯 SIGNAL [${configId}]: ${latest.direction} for ${pair} detected1111.`);
                SocketService.io.emit('strategy-signal', { configId, pair, trade: latest });

                const globalSettings = SettingsService.getSettings();
                const isRealTrade = config.autoTrade && globalSettings.isLiveTrading;
                
                if (isRealTrade) {
                    if (state.isPlacingOrder) return;
                    state.isPlacingOrder = true;
                    try {
                        SystemLogService.log('INFO', 'EXECUTION', `🚀 Executing REAL entry for ${configId} (${latest.direction}) at ${latest.entryPrice}...`);
                        await TradeService.executeFutureOrder({
                            ...latest,
                            stop_loss_price: latest.sl
                        });

                        await new Promise(res => setTimeout(res, 1000));

                        const positions = await TradeService.getPositions();
                        const cleanS = pair.replace('B-', '').toLowerCase();
                        const newPos = Array.isArray(positions)
                            ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                            : null;

                        if (newPos) {
                            state.currentPosition = newPos;
                            SystemLogService.log('INFO', 'EXECUTION', `✅ REAL Entry Verified for ${configId}.`);
                        }

                        const entryPrice = newPos?.entry_price || PriceStore.get(pair) || latest.entryPrice;
                        const savedTrade = await TradeHistoryService.saveTrade({
                            ...latest,
                            pair,
                            strategyId: config.strategyId,
                            configId,
                            direction: latest.direction,
                            entryPrice: entryPrice,
                            status: 'open',
                            type: 'real',
                            entryTime: new Date().toISOString()
                        });
                        state.activeTrade = savedTrade as any;
                    } catch (err: any) {
                        const errorMessage = err.response?.data?.message || err.message;
                        SystemLogService.log('ERROR', 'EXECUTION', `❌ REAL Execution Failed for ${configId}: ${errorMessage}`);
                    } finally {
                        state.isPlacingOrder = false;
                    }
                } else {
                    // PAPER TRADE LOGIC
                    SystemLogService.log('INFO', 'EXECUTION', `📝 Executing PAPER entry for ${configId} (${latest.direction})...`);

                    const savedTrade = await TradeHistoryService.saveTrade({
                        ...latest,
                        pair,
                        strategyId: config.strategyId,
                        configId,
                        direction: latest.direction,
                        entryPrice: latest.entryPrice,
                        status: 'open',
                        type: 'paper',
                        entryTime: new Date().toISOString()
                    });
                    state.activeTrade = savedTrade as any;
                }
            }
        } catch (err: any) {
            console.error('[Autonomous] Strategy routine failed:', err.message);
        }
    }

    private static async executeSignal(latest: Trade, configId: string, state: LiveState) {
        const config = state.config;
        const pair = config.pair;
        const cleanS = (pair || '').replace('B-', '').toLowerCase();
        const globalSettings = SettingsService.getSettings();
        const isRealTrade = config.autoTrade && globalSettings.isLiveTrading;

        SystemLogService.log('INFO', 'STRATEGY', `⚡ Executing ${isRealTrade ? 'REAL' : 'PAPER'} signal for ${configId}`);
        SocketService.io.emit('strategy-signal', { configId, pair, trade: latest });

        if (isRealTrade) {
            if (state.isPlacingOrder) return;
            state.isPlacingOrder = true;
            try {
                SystemLogService.log('INFO', 'EXECUTION', `🚀 Executing REAL SIGNAL for ${configId} at ${latest.entryPrice}...`);
                await TradeService.executeFutureOrder({
                    ...latest,
                    stop_loss_price: latest.sl,
                    take_profit_price: latest.tp
                });

                await new Promise(res => setTimeout(res, 1000));

                const positions = await TradeService.getPositions();
                const newPos = Array.isArray(positions)
                    ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                    : null;

                if (newPos) {
                    state.currentPosition = newPos;
                }

                const entryPrice = newPos?.entry_price || PriceStore.get(pair) || latest.entryPrice;
                const savedTrade = await TradeHistoryService.saveTrade({
                    ...latest,
                    pair,
                    strategyId: config.strategyId,
                    configId,
                    direction: latest.direction,
                    entryPrice: entryPrice,
                    status: 'open',
                    type: 'real',
                    entryTime: new Date().toISOString()
                });
                state.activeTrade = savedTrade as any;
            } catch (err: any) {
                const errorMessage = err.response?.data?.message || err.message;
                SystemLogService.log('ERROR', 'EXECUTION', `❌ REAL Signal Failed for ${configId}: ${errorMessage}`);
            } finally {
                state.isPlacingOrder = false;
            }
        } else {
            try {
                const savedTrade = await TradeHistoryService.saveTrade({
                    ...latest,
                    pair,
                    strategyId: config.strategyId,
                    configId,
                    direction: latest.direction,
                    entryPrice: latest.entryPrice,
                    status: 'open',
                    type: 'paper',
                    entryTime: new Date().toISOString()
                });
                state.activeTrade = savedTrade as any;
                SystemLogService.log('INFO', 'STRATEGY', `✅ PAPER trade initialized for ${configId}`);
            } catch (err: any) {
                SystemLogService.log('ERROR', 'STRATEGY', `PAPER Execution Failed for ${configId}: ${err.message}`);
            }
        }
    }

    private static async monitorRealTimeSL(tick: Candle, configId: string, state: LiveState) {
        try {
            const config = state.config;
            const activeTrade = state.activeTrade;
            if (!activeTrade || activeTrade.status !== 'open') {
                if (activeTrade && activeTrade.status !== 'open') state.activeTrade = null;
                return;
            }

            const sl = activeTrade.sl || activeTrade.stop_loss_price || 0;
            const tp = activeTrade.tp || activeTrade.take_profit_price || 0;
            const isBuy = activeTrade.direction === 'buy';

            let exitReason = '';
            if (isBuy) {
                if (sl > 0 && tick.low <= sl) exitReason = 'SL';
                else if (tp > 0 && tick.high >= tp) exitReason = 'TP';
            } else {
                if (sl > 0 && tick.high >= sl) exitReason = 'SL';
                else if (tp > 0 && tick.low <= tp) exitReason = 'TP';
            }

            if (exitReason) {
                const triggerPrice = exitReason === 'SL' ? sl : tp;
                SystemLogService.log('INFO', 'MONITOR', `🎯 ${exitReason} Triggered [${configId}] at ${tick.close} for ${activeTrade.pair}`);

                if (activeTrade.type === 'real' && !state.isClosingPosition) {
                    state.isClosingPosition = true;
                    try {
                        const pair = config.pair;
                        const cleanS = (pair || '').replace('B-', '').toLowerCase();
                        let pos = state.currentPosition;

                        if (!pos) {
                            const positions = await TradeService.getPositions();
                            pos = Array.isArray(positions)
                                ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                                : null;
                        }

                        if (pos) {
                            SystemLogService.log('INFO', 'EXECUTION', `🚀 Closing real position ${pos.id} for ${configId} due to ${exitReason} hit.`);
                            await TradeService.closePosition({ positionId: pos.id });
                        }
                    } catch (err: any) {
                        SystemLogService.log('ERROR', 'EXECUTION', `❌ Real exit failed for ${configId}: ${err.message}`);
                    }
                }

                // Update DB
                activeTrade.status = 'closed';
                activeTrade.exitPrice = tick.close;
                activeTrade.exitTime = new Date().toISOString();
                activeTrade.exitReason = `Ticket ${exitReason} Hit`;

                const { profit, fee } = calculateTradeProfit(activeTrade, tick.close, 0.0005);
                activeTrade.profit = profit;
                activeTrade.fee = fee;

                await TradeHistoryService.saveTrade(activeTrade);
                state.activeTrade = null; // 🛡️ CLEAR local reference after closure
                SocketService.io.emit('trade-history-update', activeTrade);
                state.isClosingPosition = false;
            }
        } catch (err: any) {
            console.error("Monitor status failed:", err.message);
        }
    }

    /**
     * Synchronizes state for all active configurations (History Recovery)
     */
    public static async refreshConfigs() {
        try {
            const configs = await LiveConfigService.getEnabledConfigs();
            
            // Track IDs to remove disabled ones
            const activeIds = new Set(configs.map(c => c._id.toString()));
            for (const [id, state] of SocketService.configStates.entries()) {
                if (!activeIds.has(id)) {
                    console.log(`[Lifecycle] 🛑 Removing disabled config: ${id}`);
                    SocketService.configStates.delete(id);
                }
            }

            for (const config of configs) {
                SocketService.addConfigState(config);
            }
        } catch (err: any) {
            console.error('[Lifecycle] ❌ Failed to refresh configs:', err.message);
        }
    }

    /**
     * 🛡️ MEMORY SYNC: Clears a specific trade from bot memory when deleted by user.
     */
    public static clearActiveTradeByTime(entryTime: string) {
        for (const [id, state] of SocketService.configStates.entries()) {
            if (state.activeTrade && state.activeTrade.entryTime === entryTime) {
                state.activeTrade = null;
                console.log(`[Lifecycle] 🗑️ Cleared active trade for config ${id} from memory.`);
            }
        }
    }

    /**
     * 🛡️ MEMORY SYNC: Clears ALL active trades from memory.
     */
    public static clearAllActiveTrades() {
        for (const state of SocketService.configStates.values()) {
            state.activeTrade = null;
        }
        console.log(`[Lifecycle] 🗑️ All active trades cleared from memory.`);
    }

    public static async syncExchangeState() {
        try {
            // 🔄 HOT RELOAD: Refresh enabled configurations from DB
            await SocketService.refreshConfigs();

            // Start of today in IST (Kolkata)
            const todayKolkata = dayjs().tz('Asia/Kolkata').startOf('day');
            const startOfDay = todayKolkata.valueOf();
            const from = Math.floor(startOfDay / 1000) - (7 * 86400); // 7-Day warm-up
            const to = Math.floor(Date.now() / 1000);

            // 🛡️ WAIT FOR DB
            let retries = 0;
            const mongoose = (await import('mongoose')).default;
            while (mongoose.connection.readyState !== 1 && retries < 10) {
                console.log(`[Sync] ⏳ Waiting for MongoDB readiness (attempt ${retries + 1})...`);
                await new Promise(res => setTimeout(res, 1000));
                retries++;
            }

            if (mongoose.connection.readyState !== 1) {
                console.error("[Sync] ❌ MongoDB connection failed. Skipping recovery.");
                return;
            }

            if (SocketService.configStates.size === 0) {
                console.warn("[Sync] ⚠️ No active configurations found to synchronize.");
                return;
            }

            console.log(`[Sync] 🔍 Synchronizing ${SocketService.configStates.size} active configurations...`);

            for (const [configId, state] of SocketService.configStates.entries()) {
                const config = state.config;
                const pair = config.pair;
                const resolution = config.timeInterval || '1';

                console.log(`[Recovery] 🔄 Processing ${pair} [${config.strategyId}]...`);

                // 🎯 Cache existing active trade for this config
                const activeTrade = await TradeHistoryService.getActiveTrade(configId);
                state.activeTrade = activeTrade;

                // 1. Fetch main candles
                const response = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from,
                    to,
                    resolution
                });

                if (response.s !== 'ok' || !Array.isArray(response.data)) {
                    console.warn(`[Recovery] ⚠️ No data for ${pair}`);
                    continue;
                }

                const candles: Candle[] = response.data.sort((a: any, b: any) => a.time - b.time);
                const channel = SocketService.formatChannel(pair, resolution);
                let registry = SocketService.marketRegistry.get(channel);
                if (!registry) {
                    registry = { candles: [], candleIndexMap: new Map() };
                    SocketService.marketRegistry.set(channel, registry);
                }
                registry.candles = candles;
                if (!registry.candleIndexMap) registry.candleIndexMap = new Map();
                registry.candleIndexMap.clear();
                candles.forEach((c, i) => registry.candleIndexMap!.set(c.time, i));

                // 2. Fetch sub-candles (1m) if needed
                let subCandles: Candle[] = [];
                if (resolution !== '1') {
                    const subChannel = SocketService.formatChannel(pair, '1');
                    const subRes = await CoinDCXApiService.getCandlesticks({
                        pair,
                        from: Math.floor(startOfDay / 1000),
                        to,
                        resolution: '1'
                    });
                    if (subRes.s === 'ok' && Array.isArray(subRes.data)) {
                        subCandles = subRes.data.sort((a: any, b: any) => a.time - b.time);
                        let subRegistry = SocketService.marketRegistry.get(subChannel);
                        if (!subRegistry) {
                            subRegistry = { candles: [], candleIndexMap: new Map() };
                            SocketService.marketRegistry.set(subChannel, subRegistry);
                        }
                        subRegistry.candles = subCandles;
                        if (!subRegistry.candleIndexMap) subRegistry.candleIndexMap = new Map();
                        subRegistry.candleIndexMap.clear();
                        subCandles.forEach((c, i) => subRegistry.candleIndexMap!.set(c.time, i));
                    }
                }

                // 3. Select Strategy
                const strategy = (strategies as any)[config.strategyId];
                if (!strategy) {
                    console.error(`[Recovery] ❌ Strategy ${config.strategyId} not found for ${pair}`);
                    continue;
                }

                // 4. Run Backtest Simulation for recovery
                const result = strategy.run(candles, {
                    type: 'backtest',
                    pair,
                    capital: config.initialCapital,
                    leverage: config.leverage,
                    maxPositionSize: config.maxPositionSize || 100,
                    trailingSL: false,
                    atrMultiplierSL: 1,
                    simulationStartUnix: Math.floor(startOfDay / 1000)
                }, subCandles);

                // 5. Persist recovered trades
                if (result && result.trades) {
                    for (const t of result.trades) {
                        const overlap = await TradeHistoryService.findOverlap(pair, t.entryTime);
                        if (overlap) continue;

                        await TradeHistoryService.saveTrade({
                            ...t,
                            pair,
                            strategyId: config.strategyId,
                            configId: configId,
                            type: 'recovery',
                            status: 'closed'
                        });
                    }
                }
                        console.log(`[Recovery] 💾 Saving missed trade for ${pair}-------`);

            }

            console.log(`[Sync] ✅ All configurations synchronized successfully.`);
        } catch (err: any) {
            console.error('[Sync] ❌ Critical Error during synchronization:', err.message);
            SystemLogService.log('ERROR', 'RECOVERY', `Sync Failed: ${err.message}`);
        }
    }
}
