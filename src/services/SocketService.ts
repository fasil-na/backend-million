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

export class SocketService {
    private static io: SocketIOServer;
    private static candles: Candle[] = []; // Cache for candlestick data
    private static lastPair: string = ''; // Track pair changes for cache invalidation
    private static lastResolution: string = ''; // Track resolution changes
    private static lastKnownSLHigh: number | null = null;
    private static lastKnownSLLow: number | null = null;
    private static currentPosition: Position | null = null;
    private static candleIndexMap = new Map<number, number>();
    private static isStrategyRunning = false;
    private static isPlacingOrder = false;
    private static isClosingPosition = false;


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
        
        coinDCXSocket.once('connected', () => {
            const s = SettingsService.getSettings();
            const channel = this.formatChannel(s.pair, s.timeInterval);
            console.log(`Subscribing to default channel from settings: ${channel}`);
            coinDCXSocket.subscribe(channel);
        });


if (settings.isLiveTrading) {
    const marginCurrency = settings.pair.includes('USDT') ? 'USDT' : 'INR';

    TradeService.syncLiveBalance(marginCurrency)
        .then(() => console.log('✅ Initial live balance synced'))
        .catch(err => console.error('❌ Initial balance sync failed', err));
}
    }

    private static formatChannel(pair: string, resolution: string = DEFAULT_RESOLUTION) {
        const instrument = pair.includes('B-') ? pair : `B-${pair}`;
        return `${instrument}_${resolution}m-futures`;
    }
    private static setupCoinDCXListeners() {
    coinDCXSocket.on('candlestick', async (data: Candle) => {
       const price = data.close;


        // Single settings read for entire handler
        const settings = SettingsService.getSettings();
        const pair = (data as any).pair || settings.pair;

        PriceStore.update(pair, data.close);
        // Synchronize internal candle buffer on pair/resolution change
        if (this.lastPair !== settings.pair || this.lastResolution !== settings.timeInterval) {
            this.candles = [];
            this.candleIndexMap.clear();
            this.lastPair = settings.pair;
            this.lastResolution = settings.timeInterval;
            this.lastKnownSLHigh = null;
            this.lastKnownSLLow = null;

        }

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

            // Keep buffer capped at 1000
            if (this.candles.length > 1000) {
                const removed = this.candles.shift();
                if (removed) {
                    this.candleIndexMap.delete(removed.time);
                    // Rebuild map because all indices shifted by -1 after shift()
                    this.candleIndexMap.clear();
                    this.candles.forEach((c, i) => this.candleIndexMap.set(c.time, i));
                }
            }

            // Fire strategy ONCE per candle close — no await to avoid blocking socket loop
            if (isNewCandleTrigger && settings.isLiveMonitoring) {
                console.log(`✅ Candle Closed (${settings.timeInterval}m interval). Running strategies...`);
                // this.executeLiveStrategy().catch(e => console.error("Strategy Execution Error:", e));
                   if (!this.isStrategyRunning) {
                        this.isStrategyRunning = true;
                        this.executeLiveStrategy()
                            .catch(console.error)
                            .finally(() => this.isStrategyRunning = false);
                }
            }

            
        }

        // Emit to frontend on every tick
        this.io.emit('candlestick', data);
        this.io.emit('price-change', { m: settings.pair, p: data.close });

        // Real-time SL monitoring — only when trade is open (avoid DB read every tick)
        if (settings.isLiveMonitoring && settings.activeTradeStatus === 'open') {
            // await this.monitorRealTimeSL(data);
            this.monitorRealTimeSL(data).catch(console.error);
        }
    });

coinDCXSocket.on('df-position-update', async (positions: any[]) => {
    const settings = SettingsService.getSettings();
    const pair = settings.pair;

    const pos = Array.isArray(positions)
        ? positions.find((p: any) => p.pair === pair)
        : null;

    const wasActive = !!this.currentPosition;
    const isActive = !!pos && pos.active_pos !== 0;

    if (isActive) {
        // Position is open on exchange
        this.currentPosition = pos; // always update with latest data

        if (!wasActive) {
            // State transition: flat → open (trade just entered)
            console.log(`[Position] Trade OPENED for ${pair}`);
            await SettingsService.saveSettings({ activeTradeStatus: 'open' });
            this.io.emit('settings-update', SettingsService.getSettings());
        }
    } else {
        // Position is flat on exchange
        this.currentPosition = null;

        if (wasActive) {
            // State transition: open → flat (trade just closed)
            
            console.log(`[Position] Trade CLOSED for ${pair}`);

            // Always reset SL tracking state regardless of what happens below
            this.lastKnownSLHigh = null;
            this.lastKnownSLLow = null;

            // Sync balance if live trading — but close the trade regardless of result
            if (settings.isLiveTrading) {
                const marginCurrency = pair.includes('USDT') ? 'USDT' : 'INR';
                try {
                    await TradeService.syncLiveBalance(marginCurrency);
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

        // Layer 1 — basic monitoring check
        if (!settings.isLiveMonitoring) return;


// ALWAYS SYNC FIRST
if (settings.isLiveTrading && !this.currentPosition) {
    const positions = await TradeService.getPositions();
    const livePos = Array.isArray(positions)
        ? positions.find((p: any) => p.pair === settings.pair)
        : null;

    if (livePos && livePos.active_pos !== 0) {
        this.currentPosition = livePos;
        await SettingsService.saveSettings({ activeTradeStatus: 'open' });
    } else {
        await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
    }
}
        const { pair, initialCapital, leverage, selectedStrategyId } = settings;
        const todayStart = Math.floor(dayjs().tz('Asia/Kolkata').startOf('day').valueOf() / 1000);
        const from = todayStart - (24 * 60 * 60);

        // Fetch history only if buffer is too small
        if (this.candles.length < 10) {
            console.log(`[Autonomous] Fetching historical candles for ${pair}...`);
            const now = Math.floor(Date.now() / 1000);
            const response = await CoinDCXApiService.getCandlesticks({
                pair,
                from,
                to: now,
                resolution: settings.timeInterval
            });
            if (response.s === 'ok' && Array.isArray(response.data)) {
                this.candles = response.data.sort((a: Candle, b: Candle) => a.time - b.time);
                // Rebuild index map after history fetch
                this.candleIndexMap.clear();
                this.candles.forEach((c, i) => this.candleIndexMap.set(c.time, i));
            }
        }

        if (this.candles.length === 0) {
            console.warn('[Autonomous] No candles available, skipping...');
            return;
        }

        const strategy = strategies[selectedStrategyId as keyof typeof strategies] as any;
        if (!strategy) {
            console.warn(`[Autonomous] Strategy not found: ${selectedStrategyId}`);
            return;
        }

        const lastCandle = this.candles[this.candles.length - 1]!;

        // ═══════════════════════════════════════════════
        // LAYER 2 — activeTradeStatus gate
        // If trade is open → ONLY manage trailing SL
        // Never reaches signal check below
        // ═══════════════════════════════════════════════
        if (settings.activeTradeStatus === 'open') {
            console.log('[Autonomous] Trade is OPEN — managing trailing SL only...');

            // --- Live trade trailing SL ---
            if (settings.isLiveTrading) {
                try {
                    let pos:any = this.currentPosition;
                    if (!pos) {
                        console.log('[Autonomous] No cached position, fetching from API...');
                        const positions = await TradeService.getPositions();
                        if (positions === null) {
                            console.error('[Autonomous] API failure — skipping SL update');
                            return;
                        }

                        pos = Array.isArray(positions) 
                            ? positions.find((p: any) => p.pair === settings.pair && p.active_pos !== 0)
                            : null;

                        if (!pos) {
                            // pos missing or active_pos = 0 — exchange says flat
                            console.warn('[Autonomous] State mismatch — exchange is flat but activeTradeStatus is open. Resetting...');
                            this.currentPosition = null;
                            this.lastKnownSLHigh = null;
                            this.lastKnownSLLow = null;
                            await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                            this.io.emit('settings-update', SettingsService.getSettings());
                            return;
                        }
                        this.currentPosition = pos;
                    }

                    // Handle Trailing SL for history
                    const activeTrade = await TradeHistoryService.getActiveTrade();
                    if (activeTrade && activeTrade.status === 'open' && pos) {
                        const oldSL = activeTrade.sl || Number(pos.stop_loss_price || pos.stop_loss_trigger);
                        OpeningBreakoutStrategy.updateTrailingSL(activeTrade, lastCandle);
                        
                        const newSL = activeTrade.sl || oldSL;
                        if (Math.abs(newSL - oldSL) > (oldSL * 0.0001)) {
                            console.log(`[Autonomous] Trailing SL moved from ${oldSL} to ${newSL}. Updating exchange...`);
                            await TradeService.updatePositionTPSL({
                                positionId: pos.id,
                                stopLossPrice: newSL
                            });
                            this.lastKnownSLHigh = activeTrade.lastHigh || null;
                            this.lastKnownSLLow = activeTrade.lastLow || null;
                            await TradeHistoryService.saveTrade(activeTrade);
                            this.io.emit('trade-history-update', activeTrade);
                        }
                    }
                } catch (err: any) {
                    console.error('[Autonomous] Failed to update trailing SL:', err.message);
                }
                return; 
            }
            return; 
        }

        // ═══════════════════════════════════════════════
        // LAYER 3 — exchange position double-check
        // activeTradeStatus says 'closed' but verify
        // against exchange before placing new order
        // ═══════════════════════════════════════════════
        if (settings.isLiveTrading) {


const positions = this.currentPosition 
    ? [this.currentPosition]
    : await TradeService.getPositions();
console.log(positions,'positions-----')
const livePos = Array.isArray(positions)
    ? positions.find((p: any) => p.pair === pair)
    : null;




            if (livePos && livePos.active_pos !== 0) {
                console.warn('[Autonomous] Exchange has active position but state says closed — fixing mismatch');
                this.currentPosition = livePos;
                await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                this.io.emit('settings-update', SettingsService.getSettings());
                return; // block new entry
            }
        }

        // ═══════════════════════════════════════════════
        // NEW SIGNAL CHECK
        // Only reaches here if genuinely flat on both
        // local state AND exchange
        // ═══════════════════════════════════════════════
        console.log('[Autonomous] No active trade — checking for new signal...');
        const result = strategy.run(this.candles, {
            type: 'live',
            capital: initialCapital,
            leverage: leverage,
            atrMultiplierSL: 1,
            simulationStartUnix: from
        });

        if ('matched' in result && result.matched && result.trade) {
            const latest = result.trade;
            console.log('🚀 NEW STRATEGY SIGNAL:', latest);
            this.io.emit('strategy-signal', { pair, trade: latest });

if (settings.isLiveTrading && !this.isPlacingOrder) {
    this.isPlacingOrder = true;

    try {
        await TradeService.executeFutureOrder({
            ...latest,
            stop_loss_price: latest.sl
        });

        this.lastKnownSLHigh = latest.lastHigh || latest.entryPrice;
        this.lastKnownSLLow = latest.lastLow || latest.entryPrice;

        // Record in trade history
        const entryPrice = PriceStore.get(pair) || latest.entryPrice;
        await TradeHistoryService.saveTrade({
            ...latest,
            pair,
            direction: latest.direction,
            entryPrice: entryPrice,
            status: 'open',
            type: 'auto',
            entryTime: new Date().toISOString()
        });

    } catch (err) {
        console.error('[ORDER] Placement failed:', err);
    } finally {
        this.isPlacingOrder = false;
    }
}
            // Mark trade as open AFTER order placed
            await SettingsService.saveSettings({ activeTradeStatus: 'open' });
            this.io.emit('settings-update', SettingsService.getSettings());

        } else {
            console.log('[Autonomous] No signal on this candle.');
        }

    } catch (err: any) {
        console.error('[Autonomous] Strategy execution failed:', err.message);
    }
}

    private static async monitorRealTimeSL(tick: Candle) {
    try {
        const settings = SettingsService.getSettings();
        const currentPrice = tick.close;
        // ================================
        // 🔴 LIVE TRADING SL (CRITICAL)
        // ================================
        if (settings.isLiveTrading && this.currentPosition) {
            const pos = this.currentPosition;

            const sl = Number(pos.stop_loss_price);
            const isBuy = pos.side.toLowerCase() === 'buy';

            let slHit = false;

            if (isBuy && currentPrice <= sl) slHit = true;
            if (!isBuy && currentPrice >= sl) slHit = true;
            if (!slHit || pos.active_pos === 0 || Number(pos.stop_loss_price) === 0) {
    return;
}
if (this.isClosingPosition) return;

    this.isClosingPosition = true;
    try {
    await TradeService.closePosition({
    positionId: pos.id
});
await new Promise(res => setTimeout(res, 500));

const marginCurrency = settings.pair.includes('USDT') ? 'USDT' : 'INR';
await TradeService.syncLiveBalance(marginCurrency);

           this.currentPosition = null;
                    this.lastKnownSLHigh = null;
                    this.lastKnownSLLow = null;
                        await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    this.io.emit('settings-update', SettingsService.getSettings());
    } finally {
        this.isClosingPosition = false;
    }

        }

    } catch (err: any) {
        console.error("Monitor real-time SL failed:", err.message);
    }
}
}
