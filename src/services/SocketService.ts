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

export class SocketService {
    private static io: SocketIOServer;
    private static candles: Candle[] = []; // Cache for candlestick data
    private static lastPair: string = ''; // Track pair changes for cache invalidation
    private static lastResolution: string = ''; // Track resolution changes
    private static currentPosition: Position | null = null;
    private static candleIndexMap = new Map<number, number>();
    private static isStrategyRunning = false;
    private static isPlacingOrder = false;
    private static isClosingPosition = false;
    private static lastProcessedCandleTime: number | null = null;
    private static lastSignalTime: number | null = null;

    public static getIO() {
        return this.io;
    }


    static init(server: HTTPServer) {
        this.io = new SocketIOServer(server, {
            cors: {
                origin: '*',
                methods: ["GET", "POST"]
            },
            transports: ["websocket"],
            pingInterval: 25000,
            pingTimeout: 60000,
        });
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

        coinDCXSocket.on('connected', () => {
            const s = SettingsService.getSettings();
            // ALWAYS subscribe to 1m for fast trailing SL updates
            const channel = this.formatChannel(s.pair, '1');
            console.log(`[Self-Healing] 🔄 Socket reconnected. Synchronizing state...`);
            coinDCXSocket.subscribe(channel);

            // 🛡️ RECOVERY SYNC: Fetch current exchange status to ensure no desync
            this.syncExchangeState().catch(err => console.error('[Sync] ❌ Recovery Failed:', err.message));
        });


        // if (settings.isLiveTrading) {
        //     const marginCurrency = settings.pair.includes('USDT') ? 'USDT' : 'INR';

        //     // await TradeService.syncLiveBalance(marginCurrency)
        //         .then(() => console.log('✅ Initial live balance synced'))
        //         .catch(err => console.error('❌ Initial balance sync failed', err));
        // }
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}m-futures`;
    }

    /**
     * 🛡️ SELF-HEALING: Synchronizes the local bot state with the exchange reality.
     * Prevents the bot from getting stuck in "Open" if a trade closed while server was away.
     */
    private static async syncExchangeState() {
        try {
            const settings = SettingsService.getSettings();
            const pair = settings.pair;
            const cleanS = (pair || '').replace('B-', '').toLowerCase();

            console.log(`[Sync] 🔍 Checking exchange status for ${pair}...`);

            const positions = await TradeService.getPositions();
            const livePos = Array.isArray(positions)
                ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                : null;

            if (livePos) {
                SystemLogService.log('INFO', 'SYNC', `✅ Active position found: ${pair} @ ${livePos.entry_price}`);
                this.currentPosition = livePos;
                if (settings.activeTradeStatus !== 'open') {
                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                }
            } else {
                this.currentPosition = null;
                if (settings.activeTradeStatus === 'open') {
                    SystemLogService.log('WARN', 'SYNC', `🚑 Desync fixed: Exchange is FLAT, closing local status for ${pair}.`);
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                }
            }
        } catch (err: any) {
            console.error('[Sync] Failed to synchronize state:', err.message);
        }
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data: Candle) => {
            const settings = SettingsService.getSettings();
            const incomingPair = (data as any).pair || settings.pair;

            const cleanIncoming = incomingPair.replace('B-', '').replace('_', '').toUpperCase();
            const cleanSettings = settings.pair.replace('B-', '').replace('_', '').toUpperCase();

            if (cleanIncoming !== cleanSettings) {
                return; // Ignore ghost candles from older subscriptions
            }

            // Emit to frontend on every tick
            this.io.emit('candlestick', data);

            const price = data.close;

            this.io.emit('price-change', { m: settings.pair, p: data.close });

            PriceStore.update(incomingPair, data.close);

            // Synchronize internal candle buffer on pair/resolution change
            if (this.lastPair !== settings.pair || this.lastResolution !== settings.timeInterval) {
                this.candles = [];
                this.candleIndexMap.clear();
                this.lastPair = settings.pair;
                this.lastResolution = settings.timeInterval;
         
                console.log(`[Lifecycle] 🔄 Resolution/Pair changed: ${settings.pair} ${settings.timeInterval}m. Clearing buffer.`);
            }

            // --- RESOLUTION PARTITIONING ---
            const incomingResolution = (data as any).resolution || '1';
            const isMainResolution = incomingResolution === settings.timeInterval;

            // 1. Monitor Price always (every tick/candle)
            if (settings.activeTradeStatus === 'open') {
                this.monitorRealTimeSL(data).catch(err => console.error('[Monitor] ❌ Check Error:', err.message));
            }

            // 🔍 CHECK PENDING BREAKOUT (Gold Strategy Specific)
            // This needs to run on 1m candles to catch the sweep, even if main resolution is higher.
            if (incomingResolution === '1' && settings.selectedStrategyId === 'tp-gold-opening-breakout') {
                const strategy = strategies['tp-gold-opening-breakout'] as any;
                if (strategy.constructor?.checkPendingBreakout) {
                    const result = strategy.constructor.checkPendingBreakout(data, settings);
                    if (result.matched && result.trade) {
                        console.log(`[Gold] 🚀 Pending Breakout Triggered on 1m candle!`);
                        this.executeSignal(result.trade, settings).catch(err => console.error('[Signal] ❌ Execute Error:', err.message));
                    }
                }
            }

            if (!isMainResolution) {
                return; // Auxiliary resolution (e.g. 1m when main is 5m) - skip strategy logic
            }

            // --- MAIN STRATEGY LOGIC (Main Timeframe Only) ---
            // O(1) lookup instead of O(n) findIndex
            if (this.candleIndexMap.has(data.time)) {
                // Same candle still forming — just update it
                const idx = this.candleIndexMap.get(data.time)!;
                this.candles[idx] = data;
            } else {
                // New candle arrived — previous one is now closed
                const isNewCandleTrigger = this.candles.length > 0;

                // Register in map before pushing
                this.candleIndexMap.set(data.time, this.candles.length);
                this.candles.push(data);

                if (this.candles.length > 3000) {
                    const removed = this.candles.shift();
                    if (removed) {
                        this.candleIndexMap.clear();
                        this.candles.forEach((c, i) => this.candleIndexMap.set(c.time, i));
                    }
                }

                if (isNewCandleTrigger) {
                    const closedCandle: any = this.candles[this.candles.length - 1];
                    if (this.lastProcessedCandleTime !== closedCandle.time) {
                        this.lastProcessedCandleTime = closedCandle.time;

                        const localState = settings.activeTradeStatus.toUpperCase();
                        const exchangeState = this.currentPosition ? 'ACTIVE' : 'NONE';
                        console.log(`[Status] ${incomingPair} (${incomingResolution}m): ${data.close} | Local: ${localState} | Exchange: ${exchangeState} | Flag: closing=${this.isClosingPosition}`);

                        // Strategy Scan on Interval
                        const intervalMinutes = Number(settings.timeInterval);
                        const currentTime = new Date(closedCandle.time);
                        if (currentTime.getMinutes() % intervalMinutes === 0) {
                            if (!this.isStrategyRunning) {
                                console.log(`[Lifecycle] 🚀 ${intervalMinutes}m Interval Reached. Running Strategy scan...`);
                                this.isStrategyRunning = true;
                                this.executeLiveStrategy()
                                    .catch(err => console.error('[Strategy] ❌ Scan Error:', err.message))
                                    .finally(() => this.isStrategyRunning = false);
                            }
                        }
                    }
                }
            }
        });








        coinDCXSocket.on('df-position-update', async (positions: any[]) => {
            const settings = SettingsService.getSettings();
            const pair = settings.pair;

            const wasActive = !!this.currentPosition && this.currentPosition.active_pos !== 0;

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
            } catch (err) {
                console.error("[Position] ❌ Unpacking failed:", err);
            }

            // Fuzzy matching for pair names
            const pos = posList.find((p: any) => {
                const cleanP = (p.pair || '').replace('B-', '').toLowerCase();
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                return cleanP === cleanS;
            });

            let isActive = !!pos && pos.active_pos !== 0;

            if (posList.length > 0 && !pos) {
                console.log(`[Position Debug] Received ${posList.length} positions, but none matched ${pair}. Items:`, JSON.stringify(posList));
            }

            if (isActive) this.currentPosition = pos;

            // --- ENHANCED PROTECTION AGAINST PHANTOM CLOSURES ---
            if (wasActive && !isActive) {
                if (this.isClosingPosition) {
                    console.log(`[Position] ${pair} closure detected at SL level. Finalizing state.`);
                    // Skip REST verification and proceed to closure logic
                } else {
                    console.log(`[Position] Socket suggests ${pair} is closed. Checking REST with grace period...`);

                    // Give the REST API 2 seconds to synchronize before we trust its 'Open' status
                    await new Promise(res => setTimeout(res, 2000));

                    try {
                        const livePositions = await TradeService.getPositions();
                        const confirmedPos = Array.isArray(livePositions)
                            ? livePositions.find((p: any) => p.pair === pair && p.active_pos !== 0)
                            : null;

                        if (confirmedPos) {
                            console.log(`[Position] 🚑 REST confirms trade is STILL OPEN after grace period. Ignoring socket ghost.`);
                            isActive = true;
                            this.currentPosition = confirmedPos;
                            return;
                        }
                    } catch (err) {
                        console.error(`[Position] REST verification failed, defaulting to socket 'Closed' state.`);
                    }
                }
            }

            if (isActive) {
                // Position is open on exchange
                this.currentPosition = pos;
                if (!wasActive) {
                    console.log(`[Position] 📈 Trade detected locally. Pair: ${pair} @ ${pos.entry_price}`);
                }
            } else {
                this.currentPosition = null;

                // CRITICAL FIX: Trigger closure logic if local state says 'open' OR we had a cached position
                // This handles trades that open and close (SL/TP hit) before the first socket update arrives.
                if (wasActive || settings.activeTradeStatus === 'open') {
                    // State transition: open → flat (trade just closed)

                    console.log(`[Position] Trade CLOSED for ${pair}`);

                    // Sync balance if live trading — but close the trade regardless of result
                    if (settings.isLiveTrading) {
                        const marginCurrency = pair.includes('USDT') ? 'USDT' : 'INR';
                        try {
                            // 🎯 Removed bankBalance sync to avoid AWS 404/GET body issues
                            // await TradeService.syncLiveBalance(marginCurrency);
                        } catch (err) {
                            console.error('[Position] Balance sync failed:', err);
                        }

                        // Record trade exit details 
                        try {
                            const activeTrade = await TradeHistoryService.getActiveTrade();
                            if (activeTrade && activeTrade.status === 'open') {
                                const lastCandle = this.candles[this.candles.length - 1];
                                const exitPrice = lastCandle ? lastCandle.close : activeTrade.entryPrice;

                                activeTrade.status = 'closed';
                                activeTrade.exitPrice = exitPrice;
                                activeTrade.exitTime = new Date().toISOString();
                                activeTrade.exitReason = 'Exchange Position Closed';

                                const { profit, fee } = calculateTradeProfit(activeTrade, exitPrice, 0.0005);
                                activeTrade.profit = profit;
                                activeTrade.fee = fee;

                                await TradeHistoryService.saveTrade(activeTrade);
                                console.log(`[Position] Recorded exit for ${pair} at ${exitPrice}. Profit: ${profit}`);
                                this.io.emit('trade-history-update', activeTrade);
                            }
                        } catch (err) {
                            console.error('[Position] Failed to record trade exit:', err);
                        }
                    }

                    // Always mark closed — don't let syncLiveBalance failure block this
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                }
            }

            console.log(
                `[Position] ${pair}:`,
                this.currentPosition ? `ACTIVE @ ${this.currentPosition.entry_price}` : 'NONE'
            );
        });
    }

    private static async executeLiveStrategy() {
        try {
            const settings = SettingsService.getSettings();

            // 1. Fetch latest trade to check status
            const activeTrade = await TradeHistoryService.getActiveTrade();

            if (activeTrade && activeTrade.status === 'open') {
                console.log(`[Strategy] ⏭️ Trade is ALREADY OPEN (${activeTrade.type}). Skipping signal scan.`);
                return;
            }

            // Extra safety: Check settings flag too
            if (settings.activeTradeStatus === 'open') {
                console.log(`[Strategy] ⏭️ Settings say trade is open. Skipping.`);
                return;
            }

            const pair = settings.pair;
            const latestCandle = this.candles[this.candles.length - 1];

            if (!latestCandle) return;

            // 🛑 GUARD: Prevent multiple entries for the same candle (Real vs Paper race)
            if (this.lastSignalTime === latestCandle.time) {
                return;
            }

            const leverage = settings.leverage;
            const initialCapital = settings.initialCapital;
            // 🛑 MATHEMATICAL PARITY FIX: Ensure Live explicitly mathematically strictly loads 7 Days 
            // of pure technical history precisely perfectly identically safely dynamically exactly identically matching the Backtester strictly inherently!
            const from = Math.floor(Date.now() / 1000) - (7 * 86400);

            // 2. Refresh candles if buffer is missing
            if (this.candles.length < 10) {
                console.log(`[Strategy] 📥 Buffer low (${this.candles.length}). Fetching history for ${pair}...`);
                const response = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from,
                    to: Math.floor(Date.now() / 1000),
                    resolution: settings.timeInterval
                });
                if (response.s === 'ok' && Array.isArray(response.data)) {
                    this.candles = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                    this.candleIndexMap.clear();
                    this.candles.forEach((c, i) => this.candleIndexMap.set(c.time, i));
                    console.log(`[Strategy] ✅ History loaded: ${this.candles.length} candles.`);
                }
            }

            if (this.candles.length === 0) {
                console.warn('[Strategy] ❌ No data available for analysis. Skipping cycle.');
                return;
            }

            // 3. Select Strategy
            const selectedStrategyId = settings.selectedStrategyId || 'opening-breakout';
            const strategy = strategies[selectedStrategyId as keyof typeof strategies] as any;

            if (!strategy) {
                console.error(`[Strategy] ❌ CRITICAL: Unknown strategy ID: ${selectedStrategyId}`);
                return;
            }

            // 3. One last safety sync with exchange
            const cleanS = (pair || '').replace('B-', '').toLowerCase();
            if (settings.isLiveTrading) {
                const positions = await TradeService.getPositions();
                const livePos = Array.isArray(positions)
                    ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                    : null;

                if (livePos) {
                    console.log(`[Strategy] 🚑 Exchange has active position. Syncing local state ONLY.`);
                    this.currentPosition = livePos;
                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                    return;
                }
            }

            // 🎯 NEW RISK LOGIC (Fallback-free):
            // If mode is 'capital', we use the manual budget (e.g. $250).
            // If mode is 'minimal', we use the exchange's absolute minimum required ($6).
            let liveCapital = initialCapital;
            if (settings.isLiveTrading) {
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                const staticData = TradeService.STATIC_INSTRUMENTS[cleanS] || TradeService.STATIC_INSTRUMENTS[pair] || TradeService.STATIC_INSTRUMENTS['B-' + pair] || { minNotional: 6 };
                const minNotional = staticData.minNotional || 6;

                if (settings.riskMode === 'capital') {
                    liveCapital = settings.initialCapital || 100;
                    console.log(`[Strategy] 💰 Capital Mode: Using $${liveCapital} of capital at ${leverage}x leverage.`);
                } else {
                    // Minimal Mode: Safety buffer 110% of minimum
                    const safeNotional = minNotional * 1.10;
                    liveCapital = safeNotional / leverage;
                    console.log(`[Strategy] 🛡️ Minimal Mode: Scaling down... using $${liveCapital.toFixed(4)} of capital to hit $${safeNotional.toFixed(2)} notional.`);
                }
            }

            // 4. Run Strategy Check
            const hasTradedToday = await TradeHistoryService.hasTradedToday(pair);
            console.log(`[Strategy] 🔍 Scanning ${this.candles.length} candles for '${selectedStrategyId}' signal... ${hasTradedToday ? '(Lockout Active)' : ''}`);

            const result = strategy.run(this.candles, {
                pair: pair,
                type: 'live',
                capital: liveCapital,
                leverage: leverage,
                atrMultiplierSL: 1,
                simulationStartUnix: from,
                hasTradedToday // 🛡️ One-and-Done Lockout for OpeningBreakout
            });
            console.log(result, 'result---')
            if ('matched' in result && result.matched && result.trade) {
                const latest = result.trade;
                this.lastSignalTime = latestCandle.time;
                SystemLogService.log('INFO', 'STRATEGY', `🎯 SIGNAL: ${latest.direction} for ${pair} detected. Executing...`);
                this.io.emit('strategy-signal', { pair, trade: latest });

                const isRealTrade = settings.isLiveMonitoring && settings.isLiveTrading;
                const tradeType = isRealTrade ? 'real' : 'paper';

                if (isRealTrade) {
                    if (this.isPlacingOrder) return;
                    this.isPlacingOrder = true;
                    try {
                        console.log(`[Strategy] 🚀 Executing REAL entry for ${pair}...`);
                        await TradeService.executeFutureOrder({
                            ...latest,
                            stop_loss_price: latest.sl
                        });

                        await new Promise(res => setTimeout(res, 1000));

                        const positions = await TradeService.getPositions();
                        const newPos = Array.isArray(positions)
                            ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                            : null;

                        if (newPos) {
                            this.currentPosition = newPos;
                            console.log(`[Strategy] ✅ REAL Entry Verified. Position ID: ${newPos.id} @ ${newPos.entry_price}`);
                        }

                        await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                        this.io.emit('settings-update', SettingsService.getSettings());

                        const entryPrice = newPos?.entry_price || PriceStore.get(pair) || latest.entryPrice;
                        await TradeHistoryService.saveTrade({
                            ...latest,
                            pair,
                            direction: latest.direction,
                            entryPrice: entryPrice,
                            status: 'open',
                            type: 'real',
                            entryTime: new Date().toISOString()
                        });
                        console.log(`[Strategy] 🏁 Real trade cycle initialized.`);
                    } catch (err: any) {
                        const errorMessage = err.response?.data?.message || err.message;
                        console.error('[Strategy] ❌ REAL Execution Failed:', errorMessage);
                        await TradeHistoryService.saveTrade({
                            ...latest,
                            pair,
                            direction: latest.direction,
                            entryPrice: latest.entryPrice,
                            status: 'failed',
                            type: 'real',
                            profit: 0,
                            entryTime: new Date().toISOString(),
                            executionError: errorMessage
                        });
                    } finally {
                        this.isPlacingOrder = false;
                    }
                } else {
                    // PAPER TRADE LOGIC
                    console.log(`[Strategy] 📝 Executing PAPER entry for ${pair}...`);

                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    this.io.emit('settings-update', SettingsService.getSettings());

                    await TradeHistoryService.saveTrade({
                        ...latest,
                        pair,
                        direction: latest.direction,
                        entryPrice: latest.entryPrice,
                        status: 'open',
                        type: 'paper',
                        entryTime: new Date().toISOString()
                    });
                        console.log(`[Strategy] 🏁 Paper trade cycle initialized.`);
                }
            } else {
                console.log('[Strategy] 🧊 No signal found on this candle.');
            }
        } catch (err: any) {
            console.error('[Autonomous] Strategy routine failed:', err.message);
        }
    }

    private static async executeSignal(latest: Trade, settings: any) {
        const pair = settings.pair;
        const cleanS = (pair || '').replace('B-', '').toLowerCase();
        
        SystemLogService.log('INFO', 'STRATEGY', `🎯 SIGNAL: ${latest.direction} for ${pair} detected. Executing...`);
        this.io.emit('strategy-signal', { pair, trade: latest });

        const isRealTrade = settings.isLiveMonitoring && settings.isLiveTrading;

        if (isRealTrade) {
            if (this.isPlacingOrder) return;
            this.isPlacingOrder = true;
            try {
                console.log(`[Strategy] 🚀 Executing REAL entry for ${pair}...`);
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
                    this.currentPosition = newPos;
                    console.log(`[Strategy] ✅ REAL Entry Verified. Position ID: ${newPos.id} @ ${newPos.entry_price}`);
                }

                await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                this.io.emit('settings-update', SettingsService.getSettings());

                const entryPrice = newPos?.entry_price || PriceStore.get(pair) || latest.entryPrice;
                await TradeHistoryService.saveTrade({
                    ...latest,
                    pair,
                    direction: latest.direction,
                    entryPrice: entryPrice,
                    status: 'open',
                    type: 'real',
                    entryTime: new Date().toISOString()
                });
            } catch (err: any) {
                console.error('[Strategy] ❌ REAL Execution Failed:', err.message);
            } finally {
                this.isPlacingOrder = false;
            }
        } else {
            console.log(`[Strategy] 📝 Executing PAPER entry for ${pair}...`);
            await SettingsService.saveSettings({ activeTradeStatus: 'open' });
            this.io.emit('settings-update', SettingsService.getSettings());

            await TradeHistoryService.saveTrade({
                ...latest,
                pair,
                direction: latest.direction,
                entryPrice: latest.entryPrice,
                status: 'open',
                type: 'paper',
                entryTime: new Date().toISOString()
            });
        }
    }

    private static async monitorRealTimeSL(tick: Candle) {
        try {
            const settings = SettingsService.getSettings();
            if (settings.activeTradeStatus !== 'open') return;

            const activeTrade = await TradeHistoryService.getActiveTrade();
            if (!activeTrade) return;

            const sl = activeTrade.sl || activeTrade.stop_loss_price || 0;
            const tp = activeTrade.tp || activeTrade.take_profit_price || 0;
            const isBuy = activeTrade.direction === 'buy';

            // 🎯 TICKER-BASED PRECISION: Check against the HIGH and LOW of the current tick update.
            // This ensures we catch SL/TP hits even if the 'close' price has already bounced back.
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

                if (activeTrade.type === 'real' && !this.isClosingPosition) {
                    this.isClosingPosition = true;
                    try {
                        const pair = settings.pair;
                        const cleanS = (pair || '').replace('B-', '').toLowerCase();
                        let pos = this.currentPosition;
                        
                        if (!pos) {
                            const positions = await TradeService.getPositions();
                            pos = Array.isArray(positions)
                                ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                                : null;
                        }

                        if (pos) {
                            console.log(`[Monitor] 🚀 Immediate Ticket-Based Exit for ${pair} (ID: ${pos.id})`);
                            await TradeService.closePosition({ positionId: pos.id });
                        }
                    } catch (err: any) {
                        console.error("[Monitor] ❌ Real exit failed:", err.message);
                    }
                }

                // Update DB regardless (for paper, or to mark real as closing)
                activeTrade.status = 'closed';
                activeTrade.exitPrice = tick.close;
                activeTrade.exitTime = new Date().toISOString();
                activeTrade.exitReason = `Ticket ${exitReason} Hit`;

                const { profit, fee } = calculateTradeProfit(activeTrade, tick.close, 0.0005);
                activeTrade.profit = profit;
                activeTrade.fee = fee;

                await TradeHistoryService.saveTrade(activeTrade);
                await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                this.io.emit('settings-update', SettingsService.getSettings());
                this.io.emit('trade-history-update', activeTrade);
                this.isClosingPosition = false;
            }
        } catch (err: any) {
            console.error("Monitor status failed:", err.message);
        }
    }

    /**
     * Reconstructs the current day's trade history (from 00:00) 
     * by running a dedicated backtest on the strategy.
     */
    static async recoverTodayTrades() {
        try {
            const settings = SettingsService.getSettings();
            const pair = settings.pair;
            const resolution = settings.timeInterval;

            // Start of today in IST (Kolkata)
            const todayKolkata = dayjs().tz('Asia/Kolkata').startOf('day');
            const startOfDay = todayKolkata.valueOf();

            // 🚀 WARM-UP FIX: Fetch 7 DAYS before today formally efficiently rationally seamlessly cleanly gracefully creatively smoothly organically!
            const from = Math.floor(startOfDay / 1000) - (7 * 86400);
            const to = Math.floor(Date.now() / 1000);

            console.log(`[Recovery] 🔄 Recovering trade history for ${pair} with 7-Day warm-up...`);

            // 🛡️ WAIT FOR DB: Ensure MongoDB is actually ready before we start hitting it
            let retries = 0;
            const mongoose = (await import('mongoose')).default;
            while (mongoose.connection.readyState !== 1 && retries < 10) {
                console.log(`[Recovery] ⏳ Waiting for MongoDB readiness (attempt ${retries + 1})...`);
                await new Promise(res => setTimeout(res, 1000));
                retries++;
            }

            if (mongoose.connection.readyState !== 1) {
                console.error("[Recovery] ❌ MongoDB failed to connect in time. Skipping recovery.");
                return;
            }

            // 1. Fetch main candles
            const response = await CoinDCXApiService.getCandlesticks({
                pair,
                from,
                to,
                resolution
            });

            if (response.s !== 'ok' || !Array.isArray(response.data)) {
                console.warn("[Recovery] ⚠️ No data found to recover.");
                return;
            }

            const candles = response.data.sort((a: any, b: any) => a.time - b.time);

            // 2. Fetch 1m sub-candles for accurate SL/TP simulation (EXACTLY from start of today)
            let subCandles: Candle[] = [];
            if (resolution !== '1') {
                const subRes = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from: Math.floor(startOfDay / 1000),
                    to,
                    resolution: '1',
                    limit: 2000 // Ensure we get the full day of data
                });
                console.log(`[Recovery] 📥 Loaded ${subRes.data.length} sub-candles for today (from 00:00).------------`);
                if (subRes.s === 'ok' && Array.isArray(subRes.data)) {
                    subCandles = subRes.data.sort((a: any, b: any) => a.time - b.time);
                    console.log(`[Recovery] 📥 Loaded ${subCandles.length} sub-candles for today (from 00:00).`);
                }
            }

            // 3. Select Strategy
            const selectedStrategyId = settings.selectedStrategyId || 'opening-breakout';
            const strategy = (strategies as any)[selectedStrategyId];
            if (!strategy) return;

            // 4. Run Backtest Simulation
            const result = strategy.run(candles, {
                type: 'backtest',
                pair: pair,
                capital: settings.initialCapital,
                leverage: settings.leverage,
                maxPositionSize: settings.maxPositionSize || 100,
                trailingSL: settings.trailingSL !== undefined ? settings.trailingSL : true,
                atrMultiplierSL: 1,
                simulationStartUnix: Math.floor(startOfDay / 1000)
            }, subCandles);
            // 5. Persist recovered trades
            if (result && result.trades) {
                for (const t of result.trades) {
                    // 🛡️ DUAL-TRADE PROTECTION: Skip if a Real/Paper trade already exists for this signal
                    const overlap = await TradeHistoryService.findOverlap(pair, t.entryTime);
                    if (overlap) {
                        console.log(`[Recovery] ⏭️ Skipping recovery for ${pair} at ${t.entryTime} (Real/Paper trade found)`);
                        continue;
                    }

                    console.log(`[Recovery] 💾 Saving trade for ${pair} at ${t.entryTime}. Trails found: ${t.trailingHistory?.length || 0}`);

                    if (t.trailingHistory && t.trailingHistory.length > 0) {
                        console.log(`[Recovery] 🔍 First trail sample: SL=${t.trailingHistory[0].sl}, Market=${t.trailingHistory[0].marketPrice}`);
                    }


                    await TradeHistoryService.saveTrade({
                        ...t,
                        pair,
                        type: 'recovery',
                        status: 'closed'
                    });
                }
            }

            // 6. Sync active trade if one exists at the end of the simulation
            if (result && result.activeTrade) {
                const active = result.activeTrade;

                // 🛡️ DUAL-TRADE PROTECTION for Active Trade
                const existingActive = await TradeHistoryService.getActiveTrade();
                const overlap = await TradeHistoryService.findOverlap(pair, active.entryTime);

                if (existingActive || overlap) {
                    console.log(`[Recovery] ⏭️ Active trade already exists for ${pair}. Skipping recovery version.`);
                    const s = SettingsService.getSettings();
                    if (s.activeTradeStatus !== 'open') {
                        await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                        this.io.emit('settings-update', SettingsService.getSettings());
                    }
                } else {
                    console.log('here-----=====')
                    await TradeHistoryService.saveTrade({
                        ...active,
                        pair,
                        type: 'recovery',
                        status: 'open'
                    });
                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                }
            } else {
                // Only mark closed if there's no existing REAL/PAPER trade open
                const existingRealActive = await TradeHistoryService.getActiveTrade();
                if (!existingRealActive) {
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                }
            }

            console.log(`[Recovery] ✅ Synced ${result?.trades?.length || 0} historical trades for today.`);
        } catch (err: any) {
            console.error('[Recovery] ❌ Failed to recover today\'s state:', err.message);
        }
    }
}
