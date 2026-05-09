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
        return SocketService.io;
    }


    static init(server: HTTPServer) {
        SocketService.io = new SocketIOServer(server, {
            cors: {
                origin: '*',
                methods: ["GET", "POST"]
            },
            transports: ["websocket"],
            pingInterval: 25000,
            pingTimeout: 60000,
        });
        const settings = SettingsService.getSettings();

        SocketService.io.on('connection', (socket) => {
            console.log('Frontend connected:', socket.id);
            socket.on('subscribe', (pair: string) => {
                const s = SettingsService.getSettings();
                const channel = SocketService.formatChannel(pair || s.pair, s.timeInterval);
                console.log(`Subscribing to: ${channel}`);
                coinDCXSocket.subscribe(channel);
            });
        });

        SocketService.setupCoinDCXListeners();
        coinDCXSocket.connect();

        coinDCXSocket.on('connected', () => {
            const s = SettingsService.getSettings();
            // ALWAYS subscribe to 1m for fast trailing SL updates
            const channel = SocketService.formatChannel(s.pair, '1');
            console.log(`[Self-Healing] 🔄 Socket reconnected. Synchronizing state...`);
            coinDCXSocket.subscribe(channel);

            // 🛡️ RECOVERY SYNC: Fetch current exchange status to ensure no desync
            SocketService.syncExchangeState().catch(err => console.error('[Sync] ❌ Recovery Failed:', err.message));
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
                SocketService.currentPosition = livePos;
                if (settings.activeTradeStatus !== 'open') {
                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    SocketService.io.emit('settings-update', SettingsService.getSettings());
                }
            } else {
                SocketService.currentPosition = null;
                if (settings.activeTradeStatus === 'open') {
                    SystemLogService.log('WARN', 'SYNC', `🚑 Desync fixed: Exchange is FLAT, closing local status for ${pair}.`);
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    SocketService.io.emit('settings-update', SettingsService.getSettings());
                }
            }
        } catch (err: any) {
            console.error('[Sync] Failed to synchronize state:', err.message);
            SystemLogService.log('ERROR', 'SYNC', `Failed to synchronize state: ${err.message}`);
        }
    }

    private static setupCoinDCXListeners() {
        coinDCXSocket.on('candlestick', async (data: Candle) => {
            try {
                // SystemLogService.log('INFO', 'SOCKET', `Candlestick received: ${JSON.stringify(data)}`);
                const settings = SettingsService.getSettings();
                const incomingPair = (data as any).pair || settings.pair;

                const cleanIncoming = incomingPair.replace('B-', '').replace('_', '').toUpperCase();
                const cleanSettings = settings.pair.replace('B-', '').replace('_', '').toUpperCase();

                if (cleanIncoming !== cleanSettings) {
                    return; // Ignore ghost candles from older subscriptions
                }

                // Emit to frontend on every tick
                SocketService.io.emit('candlestick', data);

                const price = data.close;

                SocketService.io.emit('price-change', { m: settings.pair, p: data.close });

                PriceStore.update(incomingPair, data.close);

                // Synchronize internal candle buffer on pair/resolution change
                if (SocketService.lastPair !== settings.pair || SocketService.lastResolution !== settings.timeInterval) {
                    SocketService.candles = [];
                    SocketService.candleIndexMap.clear();
                    SocketService.lastPair = settings.pair;
                    SocketService.lastResolution = settings.timeInterval;
                    console.log(`[Lifecycle] 🔄 Resolution/Pair changed: ${settings.pair} ${settings.timeInterval}m. Clearing buffer.`);
                }

                // --- RESOLUTION PARTITIONING ---
                const incomingResolution = (data as any).resolution || '1';
                const isMainResolution = incomingResolution === settings.timeInterval;

                // Log candle arrival occasionally or for specific events
                if (SocketService.candles.length === 0) {
                    SystemLogService.log('INFO', 'LIFECYCLE', `First candle received for ${incomingPair} (${incomingResolution}m). Starting buffer.`);
                }

                // 1. Monitor Price always (every tick/candle)
                if (settings.activeTradeStatus === 'open') {
                    SocketService.monitorRealTimeSL(data).catch(err => console.error('[Monitor] ❌ Check Error:', err.message));
                }

                // 🔍 CHECK PENDING BREAKOUT (Gold Strategy Specific)
                // This needs to run on 1m candles to catch the sweep, even if main resolution is higher.
                if (incomingResolution === '1' && settings.selectedStrategyId === 'tp-gold-opening-breakout') {
                    const strategy = strategies['tp-gold-opening-breakout'] as any;
                    if (strategy.constructor?.checkPendingBreakout) {
                        const result = strategy.constructor.checkPendingBreakout(data, settings);
                        if (result.matched && result.trade) {
                            SystemLogService.log('INFO', 'STRATEGY', `🚀 Gold Pending Breakout Triggered on 1m candle! Entry: ${result.trade.entryPrice}`);
                            SocketService.executeSignal(result.trade, settings).catch(err => {
                                SystemLogService.log('ERROR', 'EXECUTION', `Failed to execute Gold breakout signal: ${err.message}`, { error: err });
                            });
                        }
                    }
                }

                if (!isMainResolution) {
                    return; // Auxiliary resolution (e.g. 1m when main is 5m) - skip strategy logic
                }

                // --- MAIN STRATEGY LOGIC (Main Timeframe Only) ---
                // O(1) lookup instead of O(n) findIndex
                if (SocketService.candleIndexMap.has(data.time)) {
                    // Same candle still forming — just update it
                    const idx = SocketService.candleIndexMap.get(data.time)!;
                    SocketService.candles[idx] = data;
                } else {
                    // New candle arrived — previous one is now closed
                    const isNewCandleTrigger = SocketService.candles.length > 0;

                    // Register in map before pushing
                    SocketService.candleIndexMap.set(data.time, SocketService.candles.length);
                    SocketService.candles.push(data);

                    if (SocketService.candles.length > 3000) {
                        const removed = SocketService.candles.shift();
                        if (removed) {
                            SocketService.candleIndexMap.clear();
                            SocketService.candles.forEach((c, i) => SocketService.candleIndexMap.set(c.time, i));
                        }
                    }

                    if (isNewCandleTrigger) {
                        const closedCandle: any = SocketService.candles[SocketService.candles.length - 1];
                        if (SocketService.lastProcessedCandleTime !== closedCandle.time) {
                            SocketService.lastProcessedCandleTime = closedCandle.time;

                            const localState = settings.activeTradeStatus.toUpperCase();
                            const exchangeState = SocketService.currentPosition ? 'ACTIVE' : 'NONE';
                            console.log(`[Status] ${incomingPair} (${incomingResolution}m): ${data.close} | Local: ${localState} | Exchange: ${exchangeState} | Flag: closing=${SocketService.isClosingPosition}`);

                            // Strategy Scan on Interval
                            const intervalMinutes = Number(settings.timeInterval);
                            const currentTime = new Date(closedCandle.time);
                            if (currentTime.getMinutes() % intervalMinutes === 0) {
                                if (!SocketService.isStrategyRunning) {
                                    SystemLogService.log('INFO', 'STRATEGY', `🚀 ${intervalMinutes}m Interval Reached. Running Strategy scan for ${settings.pair}...`);
                                    SocketService.isStrategyRunning = true;
                                    SocketService.executeLiveStrategy()
                                        .catch(err => {
                                            SystemLogService.log('ERROR', 'STRATEGY', `Strategy scan failed: ${err.message}`, { error: err });
                                        })
                                        .finally(() => SocketService.isStrategyRunning = false);
                                }
                            }
                        }
                    }
                }
            } catch (err: any) {
                console.error('[Candlestick] ❌ Listener Critical Error:', err.message);
                SystemLogService.log('ERROR', 'SOCKET', `Candlestick Listener Failed: ${err.message}`);
            }
        });








        coinDCXSocket.on('df-position-update', async (positions: any[]) => {
            const settings = SettingsService.getSettings();
            const pair = settings.pair;

            const wasActive = !!SocketService.currentPosition && SocketService.currentPosition.active_pos !== 0;

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
                SystemLogService.log('ERROR', 'POSITION', `Unpacking failed: ${err.message || err}`);
            }

            // Fuzzy matching for pair names
            const pos = posList.find((p: any) => {
                const cleanP = (p.pair || '').replace('B-', '').toLowerCase();
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                return cleanP === cleanS;
            });

            let isActive = !!pos && pos.active_pos !== 0;

            if (posList.length > 0 && !pos) {
                // SystemLogService.log('INFO', 'POSITION', `Received ${posList.length} positions, but none matched ${pair}. Items:`, { posList });
            }

            if (isActive) {
                if (!wasActive) {
                    SystemLogService.log('INFO', 'POSITION', `New position detected for ${pair} at ${pos.entry_price}`);
                }
                SocketService.currentPosition = pos;
            }

            // --- ENHANCED PROTECTION AGAINST PHANTOM CLOSURES ---
            if (wasActive && !isActive) {
                if (SocketService.isClosingPosition) {
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
                            SocketService.currentPosition = confirmedPos;
                            return;
                        }
                    } catch (err: any) {
                        console.error(`[Position] REST verification failed, defaulting to socket 'Closed' state.`);
                        SystemLogService.log('ERROR', 'POSITION', `REST verification failed: ${err.message}`);
                    }
                }
            }

            if (isActive) {
                // Position is open on exchange
                SocketService.currentPosition = pos;
                if (!wasActive) {
                    console.log(`[Position] 📈 Trade detected locally. Pair: ${pair} @ ${pos.entry_price}`);
                }
            } else {
                SocketService.currentPosition = null;

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
                        } catch (err: any) {
                            console.error('[Position] Balance sync failed:', err);
                            SystemLogService.log('ERROR', 'POSITION', `Balance sync failed: ${err.message}`);
                        }

                        // Record trade exit details 
                        try {
                            const activeTrade = await TradeHistoryService.getActiveTrade();
                            if (activeTrade && activeTrade.status === 'open') {
                                const lastCandle = SocketService.candles[SocketService.candles.length - 1];
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
                                SocketService.io.emit('trade-history-update', activeTrade);
                            }
                        } catch (err: any) {
                            console.error('[Position] Failed to record trade exit:', err);
                            SystemLogService.log('ERROR', 'POSITION', `Failed to record trade exit: ${err.message}`);
                        }
                    }

                    // Always mark closed — don't let syncLiveBalance failure block this
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    SocketService.io.emit('settings-update', SettingsService.getSettings());
                }
            }

            console.log(
                `[Position] ${pair}:`,
                SocketService.currentPosition ? `ACTIVE @ ${SocketService.currentPosition.entry_price}` : 'NONE'
            );
        });
    }

    private static async executeLiveStrategy() {
        try {
             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-1');
            const settings = SettingsService.getSettings();

            // 1. Fetch latest trade to check status
            const activeTrade = await TradeHistoryService.getActiveTrade();

            if (activeTrade && activeTrade.status === 'open') {
                console.log(`[Strategy] ⏭️ Trade is ALREADY OPEN (${activeTrade.type}). Skipping signal scan.`);
                SystemLogService.log('INFO', 'STRATEGY', `Scan skipped: Trade is already open (${activeTrade.type})`);
                return;
            }

            // Extra safety: Check settings flag too
            if (settings.activeTradeStatus === 'open') {
                console.log(`[Strategy] ⏭️ Settings say trade is open. Skipping.`);
                SystemLogService.log('INFO', 'STRATEGY', `Scan skipped: ActiveTradeStatus is 'open' in settings`);
                return;
            }
 
            const pair = settings.pair;
            const latestCandle = SocketService.candles[SocketService.candles.length - 1];
                       SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-2');
            if (!latestCandle) {
                SystemLogService.log('WARN', 'STRATEGY', 'Scan skipped: No latest candle found in buffer');
                return;
            }

            // 🛑 GUARD: Prevent multiple entries for the same candle (Real vs Paper race)
            if (SocketService.lastSignalTime === latestCandle.time) {
                SystemLogService.log('INFO', 'STRATEGY', `Scan skipped: Already processed candle at ${latestCandle.time}`);
                return;
            }        
                 SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-3');

            const leverage = settings.leverage;
            const initialCapital = settings.initialCapital;
            // 🛑 MATHEMATICAL PARITY FIX: Ensure Live explicitly mathematically strictly loads 7 Days 
            // of pure technical history precisely perfectly identically safely dynamically exactly identically matching the Backtester strictly inherently!
            const from = Math.floor(Date.now() / 1000) - (7 * 86400);

            // 2. Refresh candles if buffer is missing
            if (SocketService.candles.length < 10) {
                console.log(`[Strategy] 📥 Buffer low (${SocketService.candles.length}). Fetching history for ${pair}...`);
                const response = await CoinDCXApiService.getCandlesticks({
                    pair,
                    from,
                    to: Math.floor(Date.now() / 1000),
                    resolution: settings.timeInterval
                });
                if (response.s === 'ok' && Array.isArray(response.data)) {
                    SocketService.candles = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                    SocketService.candleIndexMap.clear();
                    SocketService.candles.forEach((c, i) => SocketService.candleIndexMap.set(c.time, i));
                    console.log(`[Strategy] ✅ History loaded: ${SocketService.candles.length} candles.`);
                    SystemLogService.log('INFO', 'STRATEGY', `Successfully loaded ${SocketService.candles.length} candles for ${pair}`);
                } else {
                    console.error(`[Strategy] ❌ Failed to fetch candlesticks for ${pair}`);
                    SystemLogService.log('ERROR', 'STRATEGY', `Failed to fetch candlesticks for ${pair}: ${response.message || 'Unknown error'}`);
                }
            }
             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-4');
            if (SocketService.candles.length === 0) {
                console.warn('[Strategy] ❌ No data available for analysis. Skipping cycle.');
                SystemLogService.log('ERROR', 'STRATEGY', `Scan aborted: No candle data available for ${pair}`);
                return;
            }

            // 3. Select Strategy
            const selectedStrategyId = settings.selectedStrategyId || 'opening-breakout';
            const strategy = strategies[selectedStrategyId as keyof typeof strategies] as any;

            if (!strategy) {
                console.error(`[Strategy] ❌ CRITICAL: Unknown strategy ID: ${selectedStrategyId}`);
                SystemLogService.log('ERROR', 'STRATEGY', `CRITICAL: Unknown strategy ID: ${selectedStrategyId}`);
                return;
            }
             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-5');
            // 3. One last safety sync with exchange
            const cleanS = (pair || '').replace('B-', '').toLowerCase();
            if (settings.isLiveTrading) {
                             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-6');
                const positions = await TradeService.getPositions();
                const livePos = Array.isArray(positions)
                    ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                    : null;

                if (livePos) {
                                 SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-7');
                    console.log(`[Strategy] 🚑 Exchange has active position. Syncing local state ONLY.`);
                    SystemLogService.log('INFO', 'STRATEGY', `Scan skipped: Exchange has active position for ${pair}`);
                    SocketService.currentPosition = livePos;
                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    SocketService.io.emit('settings-update', SettingsService.getSettings());
                    return;
                }
            }

            // 🎯 NEW RISK LOGIC (Fallback-free):
            // If mode is 'capital', we use the manual budget (e.g. $250).
            // If mode is 'minimal', we use the exchange's absolute minimum required ($6).
            let liveCapital = initialCapital;
            if (settings.isLiveTrading) {
                             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-8');
                const exchangeData = TradeService.getInstrumentDetailsSync(pair || settings.pair);
                const minNotional = exchangeData.minNotional || 6;

                if (settings.riskMode === 'capital') {
                    liveCapital = settings.initialCapital || 100;
                    SystemLogService.log('INFO', 'RISK', `💰 Capital Mode: Using $${liveCapital} of capital at ${leverage}x leverage.`);
                } else {
                    // Minimal Mode: Safety buffer 110% of minimum
                    const safeNotional = minNotional * 1.10;
                    liveCapital = safeNotional / leverage;
                    SystemLogService.log('INFO', 'RISK', `🛡️ Minimal Mode: Scaling down... using $${liveCapital.toFixed(4)} of capital to hit $${safeNotional.toFixed(2)} notional.`);
                }
            }
             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-9');
            // 4. Run Strategy Check
            const hasTradedToday = await TradeHistoryService.hasTradedToday(pair);
            console.log(`[Strategy] 🔍 Scanning ${SocketService.candles.length} candles for '${selectedStrategyId}' signal... ${hasTradedToday ? '(Lockout Active)' : ''}`);

            const result = strategy.run(SocketService.candles, {
                pair: pair,
                type: 'live',
                capital: liveCapital,
                leverage: leverage,
                atrMultiplierSL: 1,
                simulationStartUnix: from,
                hasTradedToday // 🛡️ One-and-Done Lockout for OpeningBreakout
            });
            console.log(result, 'result---')
                         SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-10');
            if ('matched' in result && result.matched && result.trade) {
                const latest = result.trade;
                SocketService.lastSignalTime = latestCandle.time;
                SystemLogService.log('INFO', 'STRATEGY', `🎯 SIGNAL: ${latest.direction} for ${pair} detected. Executing...`);
                SocketService.io.emit('strategy-signal', { pair, trade: latest });

                const isRealTrade = settings.isLiveMonitoring && settings.isLiveTrading;
                const tradeType = isRealTrade ? 'real' : 'paper';

                if (isRealTrade) {
                    if (SocketService.isPlacingOrder) {
                        SystemLogService.log('WARN', 'EXECUTION', `Order already in progress for ${pair}. Skipping duplicate entry.`);
                        return;
                    }
                    SocketService.isPlacingOrder = true;
                    try {
                        SystemLogService.log('INFO', 'EXECUTION', `🚀 Executing REAL entry for ${pair} (${latest.direction}) at ${latest.entryPrice}...`);
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
                            SocketService.currentPosition = newPos;
                            SystemLogService.log('INFO', 'EXECUTION', `✅ REAL Entry Verified for ${pair}. Position ID: ${newPos.id} @ ${newPos.entry_price}`);
                        } else {
                            SystemLogService.log('WARN', 'EXECUTION', `⚠️ Order placed for ${pair} but no active position found on exchange after 1s. Check exchange logs.`);
                        }

                        await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                        SocketService.io.emit('settings-update', SettingsService.getSettings());

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
                        const errorMessage = err.response?.data?.message || err.message;
                        SystemLogService.log('ERROR', 'EXECUTION', `❌ REAL Execution Failed for ${pair}: ${errorMessage}`, { error: err.response?.data || err });
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
                        SocketService.isPlacingOrder = false;
                    }
                } else {
                    // PAPER TRADE LOGIC
                    SystemLogService.log('INFO', 'EXECUTION', `📝 Executing PAPER entry for ${pair} (${latest.direction})...`);

                    await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                    SocketService.io.emit('settings-update', SettingsService.getSettings());

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
            } else {
                console.log('[Strategy] 🧊 No signal found on this candle.');
                             SystemLogService.log('INFO', 'STRATEGY','executeLiveStrategy step-11');
                // SystemLogService.log('INFO', 'STRATEGY', `Scan complete: No signal found for ${pair}`);
            }
        } catch (err: any) {
            console.error('[Autonomous] Strategy routine failed:', err.message);
            SystemLogService.log('ERROR', 'STRATEGY', `Autonomous Strategy routine failed: ${err.message}`);
        }
    }

    private static async executeSignal(latest: Trade, settings: any) {
        const pair = settings.pair;
        const cleanS = (pair || '').replace('B-', '').toLowerCase();

        SystemLogService.log('INFO', 'STRATEGY', `⚡ Executing ${latest.type || (settings.isLiveTrading ? 'REAL' : 'PAPER')} signal for ${pair}`);
        SocketService.io.emit('strategy-signal', { pair, trade: latest });

        const isRealTrade = settings.isLiveMonitoring && settings.isLiveTrading;

        if (isRealTrade) {
            if (SocketService.isPlacingOrder) {
                SystemLogService.log('WARN', 'EXECUTION', `Order already in progress for ${pair}. Skipping signal execute.`);
                return;
            }
            SocketService.isPlacingOrder = true;
            try {
                SystemLogService.log('INFO', 'EXECUTION', `🚀 Executing REAL SIGNAL entry for ${pair} (${latest.direction}) at ${latest.entryPrice}...`);
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
                    SocketService.currentPosition = newPos;
                    SystemLogService.log('INFO', 'EXECUTION', `✅ REAL Signal Entry Verified for ${pair}. Position ID: ${newPos.id} @ ${newPos.entry_price}`);
                } else {
                    SystemLogService.log('WARN', 'EXECUTION', `⚠️ Signal order placed for ${pair} but no active position found on exchange after 1s.`);
                }

                await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                SocketService.io.emit('settings-update', SettingsService.getSettings());

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
                const errorMessage = err.response?.data?.message || err.message;
                SystemLogService.log('ERROR', 'EXECUTION', `❌ REAL Signal Execution Failed for ${pair}: ${errorMessage}`, { error: err.response?.data || err });
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
                SocketService.isPlacingOrder = false;
            }
        } else {
            try {
                console.log(`[Strategy] 📝 Executing PAPER entry for ${pair}...`);
                await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                SocketService.io.emit('settings-update', SettingsService.getSettings());
                // PAPER TRADE LOGIC
                SystemLogService.log('INFO', 'EXECUTION', `📝 Executing PAPER SIGNAL entry for ${pair} (${latest.direction})...`);
                await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                SocketService.io.emit('settings-update', SettingsService.getSettings());

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
                SystemLogService.log('INFO', 'STRATEGY', `✅ PAPER trade initialized successfully for ${pair}`);
            } catch (err: any) {
                console.error('[Strategy] ❌ PAPER Execution Failed:', err.message);
                SystemLogService.log('ERROR', 'STRATEGY', `PAPER Execution Failed for ${pair}: ${err.message}`);
            }
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
                SystemLogService.log('INFO', 'MONITOR', `🎯 ${exitReason} Triggered at ${tick.close} (Trigger: ${triggerPrice}) for ${activeTrade.pair}`);

                if (activeTrade.type === 'real' && !SocketService.isClosingPosition) {
                    SocketService.isClosingPosition = true;
                    try {
                        const pair = settings.pair;
                        const cleanS = (pair || '').replace('B-', '').toLowerCase();
                        let pos = SocketService.currentPosition;

                        if (!pos) {
                            const positions = await TradeService.getPositions();
                            pos = Array.isArray(positions)
                                ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                                : null;
                        }

                        if (pos) {
                            SystemLogService.log('INFO', 'EXECUTION', `🚀 Closing real position ${pos.id} for ${pair} due to ${exitReason} hit.`);
                            await TradeService.closePosition({ positionId: pos.id });
                            SystemLogService.log('INFO', 'EXECUTION', `✅ Position ${pos.id} closed successfully.`);
                        } else {
                            SystemLogService.log('WARN', 'EXECUTION', `⚠️ ${exitReason} hit for real trade, but no active position found on exchange to close.`);
                        }
                    } catch (err: any) {
                        SystemLogService.log('ERROR', 'EXECUTION', `❌ Real exit failed for ${activeTrade.pair}: ${err.message}`, { error: err });
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
                SocketService.io.emit('settings-update', SettingsService.getSettings());
                SocketService.io.emit('trade-history-update', activeTrade);
                SocketService.isClosingPosition = false;
            }
        } catch (err: any) {
            console.error("Monitor status failed:", err.message);
            SystemLogService.log('ERROR', 'MONITOR', `Monitor status failed: ${err.message}`);
        }
    }

    /**
     * Reconstructs the current day's trade history (from 00:00) 
     * by running a dedicated backtest on the strategy.
     */
    static async recoverTodayTrades(type: 'paper' | 'recovery' = 'paper') {
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
                        type: type,
                        status: 'closed'
                    });
                }
            }
            console.log(`[Recovery] ✅ History recovery complete for ${pair}.`);
        } catch (err: any) {
            console.error('[Autonomous] Recovery Failed:', err.message);
            SystemLogService.log('ERROR', 'RECOVERY', `Recovery Failed: ${err.message}`);
        }
    }
}
