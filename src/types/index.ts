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
    tp?: number | undefined;
    stop_loss_price?: number | undefined;
    take_profit_price?: number | undefined;
    status: 'open' | 'closed' | 'failed';
    profit: number;
    exitReason?: string | undefined;
    lastHigh?: number | undefined;
    lastLow?: number | undefined;
    units?: number | undefined; 
    fee?: number | undefined;
    trailingCount?: number | undefined;
    type?: 'manual' | 'auto' | 'paper' | 'real' | 'recovery' | undefined;
    pair?: string | undefined;
    configId?: string | undefined;
    strategyId?: string | undefined;
    executionError?: string | undefined;
    pnlPercent?: number | undefined;
    indicators?: any | undefined;
    initialSL?: number | undefined;
    resolution?:string;
    leverage?:number
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
    riskAmount: number;
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
        riskAmount: number;
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