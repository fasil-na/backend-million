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
        
        coinDCXSocket.on('connected', () => {
            const s = SettingsService.getSettings();
            // ALWAYS subscribe to 1m for fast trailing SL updates
            const channel = this.formatChannel(s.pair, '1'); 
            console.log(`Subscribing to 1m channel for fast trailing: ${channel}`);
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
console.log(isNewCandleTrigger,'isNewCandleTrigger--')
            // Register in map before pushing
            this.candleIndexMap.set(data.time, this.candles.length);
            this.candles.push(data);

            // Keep buffer capped at 3000 (roughly 50 hours of 1-min data) to ensure 
            // exact symmetry with the backtester's 48-hour context window.
            if (this.candles.length > 3000) {
                const removed = this.candles.shift();
                if (removed) {
                    this.candleIndexMap.delete(removed.time);
                    // Rebuild map because all indices shifted by -1 after shift()
                    this.candleIndexMap.clear();
                    this.candles.forEach((c, i) => this.candleIndexMap.set(c.time, i));
                }
            }

            // --- DUAL TRIGGER LOGIC ---
            if (isNewCandleTrigger && settings.isLiveMonitoring) {
                // Heartbeat status log
                const localState = settings.activeTradeStatus.toUpperCase();
                console.log(localState,'localState-----')
                const exchangeState = this.currentPosition ? 'ACTIVE' : 'NONE';
                console.log(`[Status] ${incomingPair}: ${data.close} | Local: ${localState} | Exchange: ${exchangeState} | Flag: closing=${this.isClosingPosition}`);

                // 1. ALWAYS manage trailing SL every 1 minute
                console.log(`[Lifecycle] 🕯️ 1m Candle Closed. Syncing Trailing SL...`);
                if(localState==='OPEN'){
                this.manageTrailingSL().catch(err => console.error('[Trailing] ❌ Sync Error:', err.message));
                }
                // 2. ONLY check for strategy signals on the user's selected interval
                const intervalMinutes = Number(settings.timeInterval);
                const currentTime = new Date(data.time);
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

        // Real-time SL Hit Monitoring (Every tick)
        if (settings.isLiveMonitoring && settings.activeTradeStatus === 'open') {
            this.monitorRealTimeSL(data).catch(err => console.error('[Monitor] ❌ Check Error:', err.message));
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

    private static async manageTrailingSL() {
        try {
            const settings = SettingsService.getSettings();
            // Note: Settings field is named correctly in the build
            if (settings.activeTradeStatus !== 'open' || !settings.isLiveTrading) {
                return;
            }

            const pair = settings.pair;
            const lastCandle = this.candles[this.candles.length - 1];
            if (!lastCandle) {
                console.log("[Trailing] No candles available to calculate trailing.");
                return;
            }

            let pos: any = this.currentPosition;
            const cleanS = (pair || '').replace('B-', '').toLowerCase();

            if (!pos) {
                // If we think a trade is open but have no cached pos, force a REST fetch
                const positions = await TradeService.getPositions();
                pos = Array.isArray(positions)
                    ? positions.find((p: any) => (p.pair || '').replace('B-', '').toLowerCase() === cleanS && p.active_pos !== 0)
                    : null;
                
                if (pos) {
                    console.log(`[Trailing] 🎉 Restored position from REST: @ ${pos.entry_price}`);
                    this.currentPosition = pos;
                } else {
                    // DESYNC HANDLER: Local says open but exchange says NONE
                    console.warn(`[Trailing] 🚑 Self-Correction: Local state says OPEN but exchange is FLAT. Force resetting status.`);
                    await SettingsService.saveSettings({ activeTradeStatus: 'closed' });
                    this.io.emit('settings-update', SettingsService.getSettings());
                    return;
                }
            }

            const activeTrade = await TradeHistoryService.getActiveTrade();
            if (activeTrade && activeTrade.status === 'open') {
                const oldSL = activeTrade.sl || Number(pos.stop_loss_price || pos.stop_loss_trigger || 0);
                
                OpeningBreakoutStrategy.updateTrailingSL(activeTrade, lastCandle);

                const calculatedSL = activeTrade.sl || oldSL;
                
                // 🎯 Dynamically round to the exact precision mandated by the exchange for this pair
                const cleanPair = (pair || '').replace('B-', '').toLowerCase();
                const staticData = TradeService.STATIC_INSTRUMENTS[cleanPair] || TradeService.STATIC_INSTRUMENTS[pair] || TradeService.STATIC_INSTRUMENTS['B-' + pair] || TradeService.STATIC_INSTRUMENTS['B-BTC_USDT'];
                const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
                
                const newSL = Number(calculatedSL.toFixed(pricePrecision)); 
                const change = Math.abs(newSL - oldSL);
                const threshold = oldSL * 0.0001; 

                if (change > threshold) {
                    console.log(`[Trailing] 📈 New peak/valley: ${lastCandle.high}/${lastCandle.low}. Moving SL: ${oldSL} -> ${newSL}`);
                    await TradeService.updatePositionTPSL({
                        positionId: pos.id,
                        stopLossPrice: newSL
                    });
                    
                    this.lastKnownSLHigh = activeTrade.lastHigh || null;
                    this.lastKnownSLLow = activeTrade.lastLow || null;
                    await TradeHistoryService.saveTrade(activeTrade);
                    this.io.emit('trade-history-update', activeTrade);
                } else {
                    // console.log(`[Trailing] No Sl Move. Price Action: H:${lastCandle.high} L:${lastCandle.low} within range.`);
                }
            } else {
                console.warn("[Trailing] ⚠️ Bot state is 'open' but no matching trade found in TradeHistory. Desync detected.");
            }
        } catch (err: any) {
            console.error('[Trailing] Failed to manage SL:', err.message);
        }
    }

    private static async executeLiveStrategy() {
        try {
            const settings = SettingsService.getSettings();
            
            // 1. If we think a trade is open locally, don't check for signals
            if (settings.activeTradeStatus === 'open') {
                console.log(`[Strategy] ⏭️ Trade is ALREADY OPEN. Skipping signal scan.`);
                return;
            }

            const pair = settings.pair;
            const leverage = settings.leverage;
            const initialCapital = settings.initialCapital;
            const from = Math.floor(Date.now() / 1000) - 86400; 

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

            // For backtest (simulation), we use `initialCapital` directly.
            let liveCapital = initialCapital;

            // Enforce Minimum Risk Sizing in Live Auto Trading:
            // Force the strategy to structure its trade size using EXACTLY the bare minimum capital 
            // required to hit the exchange's limits ($6.00). Setting to 110% of minimum for safety buffer.
            if (settings.isLiveTrading) {
                const cleanS = (pair || '').replace('B-', '').toLowerCase();
                const staticData = TradeService.STATIC_INSTRUMENTS[cleanS] || TradeService.STATIC_INSTRUMENTS[pair] || TradeService.STATIC_INSTRUMENTS['B-' + pair] || { minNotional: 6 };
                const safeNotional = (staticData.minNotional || 6) * 1.10; 
                liveCapital = safeNotional / leverage;
                console.log(`[Strategy] 🛡️ Minimum Risk Sizing: Scaling position down... using $${liveCapital.toFixed(4)} of capital to hit $${safeNotional.toFixed(2)} notional requirement at ${leverage}x leverage.`);
            }

            // 4. Run Strategy Check
            console.log(`[Strategy] 🔍 Scanning ${this.candles.length} candles for '${selectedStrategyId}' signal...`);
            const result = strategy.run(this.candles, {
                pair: pair, // 🛑 CRITICAL FIX: Pass pair down so mathematical strategies know which numeric limits to obey!
                type: 'live',
                capital: liveCapital,
                leverage: leverage,
                atrMultiplierSL: 1,
                simulationStartUnix: from
            });
console.log(result,'result---')
            if ('matched' in result && result.matched && result.trade) {
                const latest = result.trade;
                console.log(`[Strategy] 🎯 SIGNAL DETECTED: ${latest.direction} for ${pair}`);
                this.io.emit('strategy-signal', { pair, trade: latest });

                if (settings.isLiveTrading && !this.isPlacingOrder) {
                    this.isPlacingOrder = true;
                    try {
                        console.log(`[Strategy] 🚀 Executing entry for ${pair}...`);
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
                            console.log(`[Strategy] ✅ Entry Verified. Position ID: ${newPos.id} @ ${newPos.entry_price}`);
                        }

                        // ... update sl high/low ...
                        this.lastKnownSLHigh = latest.lastHigh || latest.entryPrice;
                        this.lastKnownSLLow = latest.lastLow || latest.entryPrice;

                        await SettingsService.saveSettings({ activeTradeStatus: 'open' });
                        this.io.emit('settings-update', SettingsService.getSettings());

                        const entryPrice = newPos?.entry_price || PriceStore.get(pair) || latest.entryPrice;
                        await TradeHistoryService.saveTrade({
                            ...latest,
                            pair,
                            direction: latest.direction,
                            entryPrice: entryPrice,
                            status: 'open',
                            type: 'auto',
                            entryTime: new Date().toISOString()
                        });
                        console.log(`[Strategy] 🏁 Trade cycle initialized.`);
                    } catch (err: any) {
                        console.error('[Strategy] ❌ Execution Failed:', err.message);
                    } finally {
                        this.isPlacingOrder = false;
                    }
                }
            } else {
                console.log('[Strategy] 🧊 No signal found on this candle.');
            }
        } catch (err: any) {
            console.error('[Autonomous] Strategy routine failed:', err.message);
        }
    }

    private static async monitorRealTimeSL(tick: Candle) {
        try {
            const settings = SettingsService.getSettings();
            if (!settings.isLiveTrading || !this.currentPosition) return;

            const pos:any = this.currentPosition;
            const currentPrice = tick.close;
            const sl = Number(pos.stop_loss_price || pos.stop_loss_trigger || 0);
            const side = pos.side || (pos as any).position_side || '';
            const isBuy = side.toLowerCase() === 'buy';

            // Check for SL Hit (Every Tick)
            let slHit = false;
            if (isBuy && currentPrice <= sl && sl > 0) slHit = true;
            if (!isBuy && currentPrice >= sl && sl > 0) slHit = true;

            if (slHit) {
                // We DON'T call TradeService.closePosition anymore.
                // We let the Exchange's SL trigger handle the actual closure.
                // We just log that we detected it.
                console.log(this.isClosingPosition,'this.isClosingPosition=')
                if (!this.isClosingPosition) {
                    console.log(`[Monitor] 🎯 Price hit Stop Loss level ${sl}. Waiting for Exchange to close...`);
                    this.isClosingPosition = true; // Signal to the socket listener to trust the next closure message
                }
            }
        } catch (err: any) {
            console.error("Monitor status failed:", err.message);
        }
}
}
