import type { Candle } from '../types/index.js';

// ============================================================
//  Strategy Builder  –  Exhaustive Filter Combination Tester
// ============================================================
//
//  All filter values below are "config axes".  The builder will
//  generate every possible combination of these and run a full
//  candle-by-candle simulation for each one.
// ============================================================

// ------- Tunable parameter grids -------
const EMA_SHORTS = [5, 9, 12, 20];
const EMA_LONGS = [26, 50, 100, 200];
const RSI_PERIODS = [7, 9, 14];
const RSI_THRESHOLDS = [45, 50, 55];    // RSI must be ABOVE this to go long
const VOL_MULTIPLIERS = [1.0, 1.2, 1.5];
const ATR_PERIODS = [7, 10, 14];
const ATR_SL_MULTIPLIERS = [1.0, 1.5, 2.0, 2.5]; // stop-loss distance = ATR * mult
const TRAILING_SL_MULTIPLIERS = [1.0, 1.5, 2.0]; // trailing SL distance = ATR * mult

// ── Helpers ─────────────────────────────────────────────────

function calcEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let ema = [data[0]!];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i]! * k + ema[i - 1]! * (1 - k));
    }
    return ema;
}

function calcRSI(data: number[], period: number): number {
    // Use Wilder's smoothed RS over the last `period` changes
    let gains = 0, losses = 0;
    const start = Math.max(1, data.length - period - 1);
    const end = data.length - 1;
    let count = 0;
    for (let i = start; i <= end; i++) {
        const diff = data[i]! - data[i - 1]!;
        if (diff >= 0) gains += diff;
        else losses -= diff;
        count++;
    }
    if (count === 0) return 50;
    const rs = gains / (losses || 1e-10);
    return 100 - 100 / (1 + rs);
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): number {
    const trs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        trs.push(Math.max(
            highs[i]! - lows[i]!,
            Math.abs(highs[i]! - closes[i - 1]!),
            Math.abs(lows[i]! - closes[i - 1]!)
        ));
    }
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

function avgVolume(volumes: number[], period = 20): number {
    const slice = volumes.slice(-period - 1, -1);
    return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

/**
 * Fixed lot sizing:
 *   Units = perTradeAmount / entryPrice
 */
function calcLotSize(perTradeAmount: number, entryPrice: number, leverage = 1): number {
    if (entryPrice <= 0) return 0;
    return (perTradeAmount * leverage) / entryPrice;
}

// ── Interfaces ──────────────────────────────────────────────

interface StrategyConfig {
    emaShort: number;
    emaLong: number;
    rsiPeriod: number;
    rsiThreshold: number;
    volMultiplier: number;
    atrPeriod: number;
    slMult: number;
    trailingSLMult: number;
}

interface MarketData {
    close: number[];
    high: number[];
    low: number[];
    volume: number[];
    time: number[];
}

interface TradeResult {
    entryPrice: number;
    exitPrice: number;
    units: number;
    pnl: number;
    exitReason: string;
    entryTime: number | null;
    exitTime: number | null;
}

interface StrategyResult {
    config: StrategyConfig;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPL: number;
    avgWin: number;
    avgLoss: number;
    riskReward: number | null;
    trades: TradeResult[];
}

// ── Core simulation ──────────────────────────────────────────

/**
 * Runs one strategy configuration over the market data.
 * Returns trade-level & summary metrics.
 */
function runStrategyConfig({
    marketData,
    config,
    perTradeAmount,
    feeRate,
    useTrailingSL,
    leverage = 1,
}: {
    marketData: MarketData;
    config: StrategyConfig;
    perTradeAmount: number;
    feeRate: number;
    useTrailingSL: boolean;
    leverage?: number;
}): StrategyResult | null {
    const { close, high, low, volume, time } = marketData;
    const N = close.length;
    const warmup = Math.max(config.emaLong, config.rsiPeriod, config.atrPeriod, 50);

    if (N < warmup + 5) return null;

    let totalPL = 0;
    let currentBalance = perTradeAmount; // Assume initial budget is perTradeAmount
    const trades: TradeResult[] = [];
    let position: {
        entry: number;
        units: number;
        sl: number;
        trailingSL: number;
        highestPrice: number;
        entryIdx: number;
    } | null = null;

    for (let i = warmup; i < N; i++) {
        const slice = {
            close: close.slice(0, i + 1),
            high: high.slice(0, i + 1),
            low: low.slice(0, i + 1),
            volume: volume.slice(0, i + 1),
        };
        const price = close[i]!;

        // Bankruptcy Check
        if (currentBalance <= 0) {
            break;
        }

        // ── Compute indicators ──
        const shortEMA = calcEMA(slice.close, config.emaShort).at(-1)!;
        const longEMA = calcEMA(slice.close, config.emaLong).at(-1)!;
        const rsiVal = calcRSI(slice.close, config.rsiPeriod);
        const volAvg = avgVolume(slice.volume, 20);
        const volCurr = volume[i]!;
        const atrVal = calcATR(slice.high, slice.low, slice.close, config.atrPeriod);

        const emaBullish = shortEMA > longEMA;
        const rsiOk = rsiVal > config.rsiThreshold;
        const volHigh = volCurr > volAvg * config.volMultiplier;

        // ── Manage open position ──
        if (position) {
            // Update trailing SL if enabled
            if (useTrailingSL && price > position.highestPrice) {
                position.highestPrice = price;
                position.trailingSL = price - atrVal * config.trailingSLMult;
            }

            let exitPrice: number | null = null;
            let exitReason: string | null = null;

            if (price <= position.sl) {
                exitPrice = position.sl;
                exitReason = 'Hard-SL';
            } else if (useTrailingSL && price <= position.trailingSL) {
                exitPrice = position.trailingSL;
                exitReason = 'Trail-SL';
            }

            if (exitPrice !== null && exitReason !== null) {
                const grossPnL = (exitPrice - position.entry) * position.units;
                const fees = (position.entry * position.units + exitPrice * position.units) * feeRate;
                const netPnL = grossPnL - fees;

                totalPL += netPnL;
                currentBalance += netPnL;

                trades.push({
                    entryPrice: position.entry,
                    exitPrice,
                    units: position.units,
                    pnl: netPnL,
                    exitReason,
                    entryTime: time ? time[position.entryIdx] ?? null : null,
                    exitTime: time ? time[i] ?? null : null,
                });
                position = null;
            }
            continue;
        }

        // ── Entry signal ──
        if (emaBullish && rsiOk && volHigh) {
            const stopLoss = price - atrVal * config.slMult;
            const units = calcLotSize(currentBalance, price, leverage);
            if (units > 0) {
                position = {
                    entry: price,
                    units,
                    sl: stopLoss,
                    trailingSL: price - atrVal * config.trailingSLMult,
                    highestPrice: price,
                    entryIdx: i,
                };
            }
        }
    }

    // Force-close any open position at last price
    if (position) {
        const exitPrice = close.at(-1)!;
        const grossPnL = (exitPrice - position.entry) * position.units;
        const fees = (position.entry * position.units + exitPrice * position.units) * feeRate;
        const netPnL = grossPnL - fees;
        totalPL += netPnL;
        trades.push({
            entryPrice: position.entry,
            exitPrice,
            units: position.units,
            pnl: netPnL,
            exitReason: 'End-of-data',
            entryTime: time ? time[position.entryIdx] ?? null : null,
            exitTime: time ? time.at(-1) ?? null : null,
        });
    }

    if (trades.length === 0) return null;

    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const winRate = (wins / trades.length) * 100;
    const avgWin = wins > 0 ? trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
    const avgLoss = losses > 0 ? Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses) : 0;
    const rr = avgLoss > 0 ? avgWin / avgLoss : null;

    return {
        config,
        totalTrades: trades.length,
        wins,
        losses,
        winRate: +winRate.toFixed(2),
        totalPL: +totalPL.toFixed(4),
        avgWin: +avgWin.toFixed(4),
        avgLoss: +avgLoss.toFixed(4),
        riskReward: rr !== null ? +rr.toFixed(2) : null,
        trades,
    };
}

// ── Public API ───────────────────────────────────────────────

/**
 * strategyBuilder
 */
export function strategyBuilder({
    marketData,
    perTradeAmount = 100,
    feeRate = 0.0002,
    useTrailingSL = true,
    leverage = 1,
}: {
    marketData: MarketData;
    perTradeAmount?: number;
    feeRate?: number;
    useTrailingSL?: boolean;
    leverage?: number;
}): { results: StrategyResult[]; totalCombinations: number } {
    const results: StrategyResult[] = [];
    let total = 0;

    for (const emaShort of EMA_SHORTS) {
        for (const emaLong of EMA_LONGS) {
            if (emaShort >= emaLong) continue;
            for (const rsiPeriod of RSI_PERIODS) {
                for (const rsiThreshold of RSI_THRESHOLDS) {
                    for (const volMultiplier of VOL_MULTIPLIERS) {
                        for (const atrPeriod of ATR_PERIODS) {
                            for (const slMult of ATR_SL_MULTIPLIERS) {
                                for (const trailingSLMult of TRAILING_SL_MULTIPLIERS) {
                                    if (!useTrailingSL && trailingSLMult !== TRAILING_SL_MULTIPLIERS[0]) continue;

                                    total++;
                                    const config: StrategyConfig = {
                                        emaShort,
                                        emaLong,
                                        rsiPeriod,
                                        rsiThreshold,
                                        volMultiplier,
                                        atrPeriod,
                                        slMult,
                                        trailingSLMult,
                                    };

                                    const result = runStrategyConfig({
                                        marketData,
                                        config,
                                        perTradeAmount,
                                        feeRate,
                                        useTrailingSL,
                                        leverage,
                                    });

                                    if (result) results.push(result);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    results.sort((a, b) => b.totalPL - a.totalPL);

    return { results, totalCombinations: total };
}
