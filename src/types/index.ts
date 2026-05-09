export interface Trade {
    rangeHigh?: number | undefined;
    rangeLow?: number | undefined;
    breakoutTime?: string | undefined;
    entryTime: string;
    exitTime?: string | undefined;
    direction: 'buy' | 'sell';
    entryPrice: number;
    exitPrice?: number | undefined;
    sl?: number | undefined;
    initialSL?: number | undefined;
    tp?: number | undefined;
    stop_loss_price?: number | undefined;
    take_profit_price?: number | undefined;
    status: 'open' | 'closed' | 'failed';
    profit: number;
    exitReason?: string | undefined;
    units?: number | undefined; 
    fee?: number | undefined;
    pnlPercent?: number | undefined;
    type?: 'manual' | 'auto' | 'paper' | 'real' | 'recovery' | undefined;
    pair?: string | undefined;
    strategyId?: string | undefined;
    configId?: string | undefined;
    executionError?: string | undefined;
    indicators?: any;
    // Legacy Trailing SL fields
    lastHigh?: number | undefined;
    lastLow?: number | undefined;
    trailingCount?: number | undefined;
    trailingHistory?: any[] | undefined;
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

export type Position = {
  id: string;
  pair: string;
  side: string;
  entry_price: number;
  stop_loss_price: number;
  active_pos: number;
};