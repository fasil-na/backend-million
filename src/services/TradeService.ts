import axios from 'axios';
import crypto from 'crypto';
import { SettingsService } from './SettingsService.js';
import { formatPair } from '../strategies/StrategyUtils.js';
import type { Trade } from '../types/index.js';

export class TradeService {
    private static get credentials() {
        return {
            apiKey: process.env.COINDCX_API_KEY || '',
            apiSecret: process.env.COINDCX_API_SECRET || ''
        };
    }

    private static baseUrl = "https://api.coindcx.com";



    // final excecution of trade
    static async executeFutureOrder(trade: Partial<Trade> & { pair?: string, leverage?: number | undefined, stop_loss_price?: number | undefined, take_profit_price?: number | undefined }) {
        const { apiKey, apiSecret } = this.credentials;

        if (!apiKey || !apiSecret) {
            console.error("❌ CoinDCX API Key or Secret missing in .env. Skipping trade execution.");
            return;
        }

        const settings = SettingsService.getSettings();
        const timeStamp = Math.floor(Date.now());

        const rawPair = trade.pair || settings.pair;
        const pair = formatPair(rawPair);
        
        const body = {
            "timestamp": timeStamp,
            "order": {
                "side": trade.direction?.toLowerCase(), // "buy" or "sell"
                "pair": pair,
                "order_type": "market_order",
                "price": null,
                "total_quantity": Number(trade.units),
                "leverage": settings.leverage,
                "notification": "no_notification",
                "time_in_force": "good_till_cancel",
                "hidden": false,
                "post_only": false,
                "margin_currency_short_name": pair.includes('USDT') ? "USDT" : "INR",
                "take_profit_price": Number(trade.take_profit_price || trade.tp || 0),
                "stop_loss_price": Number(trade.stop_loss_price || trade.sl || 0)
            }
        };

        console.log(body, 'body======')

        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

        try {
            console.log(`[TradeService] 🚀 Executing ${trade.direction?.toUpperCase()} order for ${pair}...`);
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/orders/create`, body, {
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

    static async getBalances() {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return null;

        const timeStamp = Math.floor(Date.now());
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');

        try {
            const response = await axios.post(`${this.baseUrl}/exchange/v1/users/balances`, bodyString, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error: any) {
            console.error("❌ Failed to fetch balances:", error.response?.data || error.message);
            return null;
        }
    }
}

