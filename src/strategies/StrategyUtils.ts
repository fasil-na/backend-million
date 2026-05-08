import type { Candle, Trade } from '../types/index.js';

export interface LotSizingParams {
    capital: number;
    maxPositionSize?: number; // Max percentage of capital to use for a single position (e.g. 100 for 100%)
    feeRate: number;
    leverage?: number; // Add leverage for futures
}

export function calculateUnits(
    entryPrice: number,
    stopLoss: number,
    params: LotSizingParams
): number {
    if (entryPrice <= 0) return 0;

    // Direct Capital-based sizing (Compounding with Leverage)
    // Units = (Capital * PositionSize% * Leverage) / EntryPrice
    const effectiveCapital = params.capital * (params.leverage || 1);
    const maxCapitalForTrade = effectiveCapital * ((params.maxPositionSize || 100) / 100);
    const units = maxCapitalForTrade / entryPrice;

    return units;
}

export function calculateTradeProfit(
    trade: Trade,
    exitPrice: number,
    feeRate: number
) {
    const units = trade.units || 0;

    const grossProfit = trade.direction === 'buy'
        ? (exitPrice - trade.entryPrice) * units
        : (trade.entryPrice - exitPrice) * units;

    const entryVal = trade.entryPrice * units;
    const exitVal = exitPrice * units;
    const fee = (entryVal + exitVal) * feeRate;

    return {
        profit: parseFloat((grossProfit - fee).toFixed(2)),
        fee: parseFloat(fee.toFixed(2)),
        grossProfit: parseFloat(grossProfit.toFixed(2)),
        points: parseFloat((exitPrice - trade.entryPrice).toFixed(2))
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