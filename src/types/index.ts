export interface Trade {
    rangeHigh?: number;
    rangeLow?: number;
    breakoutTime?: string;
    entryTime: string;
    exitTime?: string;
    direction: 'buy' | 'sell';
    entryPrice: number;
    exitPrice?: number;
    sl?: number;
    tp?: number;
    status: 'open' | 'closed';
    profit: number;
    exitReason?: string;
    lastHigh?: number;
    lastLow?: number;
    units?: number; // position size based on capital
    fee?: number;   // total fees for this trade
}

export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface BacktestParams {
    initialCapital: number;
    resolution: string;
}

export interface BacktestResult {
    trades: Trade[];
    summary: {
        totalProfit: number;
        count: number;
        successCount: number;
        failedCount: number;
        winRate: number;
        initialCapital: number;
    };
}
