import type { Candle, Trade } from '../types/index.js';
 
export interface LotSizingParams {
    riskAmount: number;
    maxPositionSize?: number; // Max percentage of total account to use (notional)
    feeRate: number;
    leverage?: number;
}
 
export function calculateUnits(
    entryPrice: number,
    stopLoss: number,
    params: LotSizingParams
): number {
    if (entryPrice <= 0 || stopLoss <= 0) return 0;
 
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    if (riskPerUnit === 0) return 0;

    // Units = Risk Amount / Risk Per Unit
    let units = params.riskAmount / riskPerUnit;

    return units;
}
 
export function calculateTradeProfit(
    trade: Trade,
    exitPrice: number,
    feeRate: number = 0.0006 // fallback if we don't have distinct maker/taker
) {
    const units = trade.units || 0;
 
    const grossProfit = trade.direction === 'buy'
        ? (exitPrice - trade.entryPrice) * units
        : (trade.entryPrice - exitPrice) * units;
 
    const pnlPercent = trade.entryPrice > 0 ? (grossProfit / (trade.entryPrice * units / (trade.leverage || 1))) * 100 : 0;
    
    const MAKER_FEE_RATE = 0.0003;
    const TAKER_FEE_RATE = 0.0006;

    const entryFee = Math.ceil(trade.entryPrice * units * MAKER_FEE_RATE * 1000) / 1000;
    const exitFee = Math.ceil(exitPrice * units * TAKER_FEE_RATE * 1000) / 1000;
    const totalFee = entryFee + exitFee;

    return {
        profit: parseFloat((grossProfit - totalFee).toFixed(3)),
        fee: parseFloat(totalFee.toFixed(3)),
        grossProfit: parseFloat(grossProfit.toFixed(3)),
        entryFee: parseFloat(entryFee.toFixed(3)),
        exitFee: parseFloat(exitFee.toFixed(3)),
        points: parseFloat((exitPrice - trade.entryPrice).toFixed(3)),
        pnlPercent: parseFloat(pnlPercent.toFixed(2))
    };
}
 
export function calculateATR(candles: Candle[], period = 14): number {
    if (candles.length <= period) return 0;
    let trs: number[] = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        if (!c || !prev) continue;
        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close)
        );
        trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
}
 
export function formatPair(pair: string): string {
    if (!pair) return '';
    if (pair.startsWith('B-')) return pair;
    
    let formatted = pair;
    if (!formatted.includes('_')) {
        if (formatted.endsWith('USDT')) {
            formatted = formatted.replace('USDT', '_USDT');
        } else if (formatted.endsWith('INR')) {
            formatted = formatted.replace('INR', '_INR');
        }
    }
    
    return `B-${formatted}`;
}
 
export function calculateEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let ema = data[0] || 0;
    const results = [ema];
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] || 0) * k + ema * (1 - k);
        results.push(ema);
    }
    return results;
}
 
export function calculateRSI(data: number[], period: number = 14): number[] {
    const rsi: number[] = new Array(data.length).fill(0);
    if (data.length <= period) return rsi;
 
    let gains = 0;
    let losses = 0;
 
    for (let i = 1; i <= period; i++) {
        const current = data[i];
        const prev = data[i-1];
        if (current === undefined || prev === undefined) continue;
        const diff = current - prev;
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
 
    let avgGain = gains / period;
    let avgLoss = losses / period;
 
    for (let i = period + 1; i < data.length; i++) {
        const current = data[i];
        const prev = data[i-1];
        if (current === undefined || prev === undefined) continue;
        const diff = current - prev;
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
 
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
 
        if (avgLoss === 0) rsi[i] = 100;
        else {
            const rs = avgGain / avgLoss;
            rsi[i] = 100 - (100 / (1 + rs));
        }
    }
 
    return rsi;
}
 