import axios from 'axios';
import crypto from 'crypto';
import { SettingsService } from './SettingsService.js';
import { formatPair } from '../strategies/StrategyUtils.js';
import type { Trade } from '../types/index.js';
import { LoggerService } from './LoggerService.js';

export class TradeService {
    private static get credentials() {
        return {
            apiKey: process.env.COINDCX_API_KEY || '',
            apiSecret: process.env.COINDCX_API_SECRET || ''
        };
    }

    private static baseUrl = "https://api.coindcx.com";

    private static instrumentCache = new Map<string, any>();

    static async getInstrumentDetails(pair: string) {
        if (this.instrumentCache.has(pair)) {
            return this.instrumentCache.get(pair);
        }
        try {
            const marginCurrency = pair.includes('USDT') ? 'USDT' : 'INR';
            const response = await axios.get(`${this.baseUrl}/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=${marginCurrency}`);
            const data = response.data.instrument;
            if (data) {
                this.instrumentCache.set(pair, data);
                return data;
            }
        } catch (error: any) {
            console.error(`❌ Failed to fetch instrument details for ${pair}:`, error.message);
        }
        return null;
    }


    public static readonly STATIC_INSTRUMENTS: Record<string, any> = {
        'B-BTC_USDT': { maxLeverage: 20, qtyStep: 0.001, priceStep: 0.1, minNotional: 6 },
        'B-SUSHI_USDT': { maxLeverage: 10, qtyStep: 1, priceStep: 0.0001, minNotional: 6 },
        'B-XAU_USDT': { maxLeverage: 20, qtyStep: 0.01, priceStep: 0.01, minNotional: 6 },
        'SUSHIUSDT': { maxLeverage: 10, qtyStep: 1, priceStep: 0.0001, minNotional: 6 },
    };

    static formatTradeParams(rawPair: string, rawQty: number, leverage: number, customTp: number = 0, customSl: number = 0, tradeDirection: string = 'buy', entryPrice: number = 0, maxNotional: number = 1000000, riskAmount: number = 0) {
        const pair = formatPair(rawPair);
        const staticData = this.STATIC_INSTRUMENTS[pair] || this.STATIC_INSTRUMENTS['B-BTC_USDT'];

        const maxLeverage = Math.min(leverage, staticData.maxLeverage);
        const pricePrecision = staticData.priceStep.toString().split('.')[1]?.length || 0;
        const tpPrice = customTp > 0 ? Number(Number(customTp).toFixed(pricePrecision)) : 0;
        const slPrice = customSl > 0 ? Number(Number(customSl).toFixed(pricePrecision)) : 0;

        let qty = rawQty;

        // 0. If riskAmount is provided, calculate qty based on risk
        if (riskAmount > 0 && entryPrice > 0 && slPrice > 0) {
            const riskPerUnit = Math.abs(entryPrice - slPrice);
            if (riskPerUnit > 0) {
                qty = riskAmount / riskPerUnit;
            }
        }

        const step = staticData.qtyStep;
        const qtyPrecision = step.toString().split('.')[1]?.length || 0;
        qty = Math.floor(qty / step) * step;
        qty = Number(qty.toFixed(qtyPrecision));

        // // 1. Cap by maxNotional to prevent 'Insufficient funds'
        // if (entryPrice > 0) {
        //     const currentNotional = qty * entryPrice;
        //     if (currentNotional > maxNotional) {
        //         console.log(`⚠️ Capping notional from $${currentNotional.toFixed(2)} to $${maxNotional.toFixed(2)}`);
        //         qty = maxNotional / entryPrice;
        //         qty = Math.floor(qty / staticData.qtyStep) * staticData.qtyStep;
        //     }
        // }

        // 2. Enforce minimum quantity based on minimum notional requirement
        if (entryPrice > 0) {
            const minNotional = staticData.minNotional || 6;
            const step = staticData.qtyStep;
            const minQty = Math.ceil((minNotional / entryPrice) / step) * step;
            if (qty < minQty) {
                throw new Error(`Calculated quantity ${qty.toFixed(qtyPrecision)} is less than minimum required ${minQty.toFixed(qtyPrecision)} for ${pair}. Skipping trade to avoid excessive risk.`);
            }
        }

        const marginName = pair.includes('USDT') ? 'USDT' : 'INR';

        const formattedEntryPrice = entryPrice > 0 ? Number(Number(entryPrice).toFixed(pricePrecision)) : 0;

        return { pair, qty: Number(qty.toFixed(qtyPrecision)), maxLeverage, tpPrice, slPrice, marginName, formattedEntryPrice };
    }

    // final excecution of trade
    static async executeFutureOrder(trade: Partial<Trade> & { pair?: string | undefined, leverage?: number | undefined, stop_loss_price?: number | undefined, take_profit_price?: number | undefined, riskAmount?: number, orderType?: string }) {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) {
            console.error("❌ CoinDCX API Key or Secret missing in .env. Skipping trade execution.");
            return;
        }

        const settings = SettingsService.getSettings();
        const timeStamp = Math.floor(Date.now()); // API strictly requires milliseconds, NOT seconds.

        try {
            const { pair, qty, maxLeverage, tpPrice, slPrice, marginName, formattedEntryPrice } = this.formatTradeParams(
                trade.pair || settings.pair,
                Number(trade.units),
                Number(trade.leverage) || 10, // Use leverage from trade config (LiveConfig), default to 10 if missing
                Number(trade.take_profit_price || trade.tp || 0),
                Number(trade.stop_loss_price || trade.sl || 0),
                trade.direction || 'buy',
                trade.entryPrice || 0,
                (trade as any).maxPositionSize || 85,
                trade.riskAmount || .05
            );

            const baseOrder: any = {
                side: trade.direction?.toLowerCase() || 'buy',
                pair: pair,
                order_type: trade.orderType || "market_order",
                price: trade.orderType === 'limit_order' ? formattedEntryPrice : null,
                total_quantity: qty,
                leverage: maxLeverage,
                notification: "no_notification",
                time_in_force: trade.orderType === 'limit_order' ? "good_till_cancel" : null,
                margin_currency_short_name: marginName
            };

            if (tpPrice > 0) baseOrder.take_profit_price = tpPrice;
            if (slPrice > 0) baseOrder.stop_loss_price = slPrice;

            const body = {
                "timestamp": timeStamp,
                "order": baseOrder
            };

            const payload = Buffer.from(JSON.stringify(body)).toString();
            const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

            await LoggerService.log('info', `🚀 Sending ${trade.direction?.toUpperCase()} order for ${pair}...`, 'TradeService', { pair, metadata: body });

            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/orders/create`, body, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                },
                timeout: 10000 // 10s timeout
            });

            await LoggerService.log('success', `✅ Trade Executed: ${trade.direction?.toUpperCase()} ${qty} ${pair} @ Market`, 'TradeService', { pair, metadata: response.data });
            return response.data;
        } catch (error: any) {
            const errorData = error.response?.data;
            const status = error.response?.status;

            const errorMsg = errorData?.message || error.message;

            throw new Error(errorMsg);
        }
    }


    static async updatePositionTPSL(params: {
        positionId: string,
        stopLossPrice?: number | undefined,
        takeProfitPrice?: number | undefined
    }) {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return;

        const timeStamp = Math.floor(Date.now());
        const body: any = {
            "timestamp": timeStamp,
            "id": params.positionId
        };

        if (params.takeProfitPrice) {
            body.take_profit = {
                "stop_price": params.takeProfitPrice.toString(),
                "order_type": "take_profit_market"
            };
        }

        if (params.stopLossPrice) {
            body.stop_loss = {
                "stop_price": params.stopLossPrice.toString(),
                "order_type": "stop_market"
            };
        }

        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

        try {
            console.log(`[TradeService] 🔄 Updating TPSL for position ${params.positionId}...`);
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/positions/create_tpsl`, body, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });

            console.log("✅ CoinDCX TPSL Updated:", response.data);
            return response.data;
        } catch (error: any) {
            console.error("❌ CoinDCX TPSL Update Failed:", error.response?.data || error.message);
            throw error;
        }
    }

    static async getPositions() {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return [];

        const timeStamp = Math.floor(Date.now());
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');

        try {
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/positions`, bodyString, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error: any) {
            console.error("❌ Failed to fetch positions:", error.response?.data || error.message);
            return null
        }
    }

    static async getOrders() {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return [];

        const timeStamp = Math.floor(Date.now());
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');

        try {
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/orders`, bodyString, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error: any) {
            console.error("❌ Failed to fetch orders:", error.response?.data || error.message);
            return null;
        }
    }

    static async cancelAllOrders(pair: string) {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return;

        try {
            // First get all orders
            const orders = await this.getOrders();
            if (!Array.isArray(orders)) return;

            // Find open orders for this pair
            const openOrders = orders.filter(o => o.pair === pair && o.status === 'open');
            if (openOrders.length === 0) {
                console.log(`ℹ️ No active limit orders to cancel for ${pair}`);
                return;
            }

            console.log(`[TradeService] Found ${openOrders.length} open orders for ${pair}. Cancelling...`);

            // Cancel each one
            for (const order of openOrders) {
                const timeStamp = Math.floor(Date.now());
                const cancelBody = { timestamp: timeStamp, id: order.id };
                const cancelBodyString = JSON.stringify(cancelBody);
                const cancelSignature = crypto.createHmac('sha256', apiSecret).update(cancelBodyString).digest('hex');

                await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/orders/cancel`, cancelBodyString, {
                    headers: {
                        'X-AUTH-APIKEY': apiKey,
                        'X-AUTH-SIGNATURE': cancelSignature,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`✅ Cancelled order ${order.id} for ${pair}`);
                
                // Slight delay to prevent rate limiting
                await new Promise(r => setTimeout(r, 200));
            }
            return { message: 'success' };
        } catch (error: any) {
            console.error(`❌ Failed to cancel orders for ${pair}:`, error.response?.data || error.message);
            return null;
        }
    }

    static async getBalances() {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return null;

        const timeStamp = Math.floor(Date.now());
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');

        try {
            // Using GET method with headers as required by CoinDCX for this endpoint
            const response = await axios.get(`${this.baseUrl}/exchange/v1/derivatives/futures/wallets`, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                },
                // Some environments/versions of axios might require the body in 'data' for GET requests 
                // if the signature was generated based on it.
                data: bodyString
            });
            return response.data;
        } catch (error: any) {
            console.error("❌ Failed to fetch balances:", error.response?.data || error.message);
            return null;
        }
    }

    static async syncLiveBalance(currency: string = 'USDT') {
        const balances = await this.getBalances();
        if (Array.isArray(balances)) {
            const marginBalance = balances.find((b: any) => b.currency_short_name === currency);
            if (marginBalance && marginBalance.balance !== undefined) {
                // If locked balance exists, we may want to include it or just use available. Usually 'balance' represents the usable margin or total margin.
                const totalBalance = Number(marginBalance.balance);
                const { SettingsService } = await import('./SettingsService.js');
                await SettingsService.saveSettings({ bankBalance: totalBalance });
                console.log(`✅ Live Bank Balance Synced: ${totalBalance} ${currency}`);
                return totalBalance;
            }
        }
        return null;
    }
    static async closePosition({ positionId }: { positionId: string }) {
        const { apiKey, apiSecret } = this.credentials;

        if (!apiKey || !apiSecret) {
            console.error("❌ CoinDCX API Key or Secret missing in .env. Skipping trade execution.");
            return;
        }
        const timeStamp = Math.floor(Date.now());
        const body = {
            timestamp: timeStamp,
            id: positionId
        };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

        try {
            console.log(`[TradeService] 🚀 Exit order for ${positionId}...`);
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/positions/exit`, body, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });

            console.log("✅ CoinDCX Trade Executed Successfully:", JSON.stringify(response.data, null, 2));
            return response.data;
        } catch (error: any) {
            console.error("❌ CoinDCX Trade Execution Failed:", error.response?.data || error.message);
            throw error;
        }
    }
}

