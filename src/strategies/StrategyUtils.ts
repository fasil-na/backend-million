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
): { profit: number; fee: number } {
    const units = trade.units || 0;
    const entryVal = trade.entryPrice * units;
    const exitVal = exitPrice * units;

    const grossProfit = trade.direction === 'buy'
        ? (exitPrice - trade.entryPrice) * units
        : (trade.entryPrice - exitPrice) * units;

    const fee = (entryVal + exitVal) * feeRate;
    return {
        profit: grossProfit - fee,
        fee
    };
}


// export function calculatePositionSize({
//     capital,
//     entryPrice,
//     stopLossPrice,
//     feePercent = 0.001 // 0.1%
// }) {
//     const riskAmount = (capital) / 100;

//     const stopDistance = Math.abs(entryPrice - stopLossPrice);

//     if (stopDistance === 0) return 0;

//     // Raw quantity
//     let qty = riskAmount / stopDistance;

//     // Adjust for fees (entry + exit)
//     const feeBuffer = 1 + feePercent * 2;
//     qty = qty / feeBuffer;

//     return qty;
// }