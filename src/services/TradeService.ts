import axios from 'axios';
import crypto from 'crypto';
import { SettingsService } from './SettingsService.js';
import { formatPair } from '../strategies/StrategyUtils.js';
import type { Trade } from '../types/index.js';
import { Instrument } from '../models/Instrument.js';

export class TradeService {
    private static get credentials() {
        return {
            apiKey: process.env.COINDCX_API_KEY || '',
            apiSecret: process.env.COINDCX_API_SECRET || ''
        };
    }

    private static baseUrl = "https://api.coindcx.com";
    private static instrumentCache = new Map<string, any>();

    /**
     * 🛡️ DYNAMIC SYNC: Fetches latest instrument constraints from CoinDCX and persists to DB.
     * This eliminates the need for hardcoded static data.
     */
    static async syncInstruments() {
        const pairsToSync = ['B-BTC_USDT', 'B-ETH_USDT', 'B-XAU_USDT', 'B-SUSHI_USDT'];
        console.log(`[InstrumentSync] 🔄 Starting daily synchronization for ${pairsToSync.length} pairs...`);

        for (const pair of pairsToSync) {
            try {
                const marginCurrency = pair.includes('USDT') ? 'USDT' : 'INR';
                const response = await axios.get(`${this.baseUrl}/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=${marginCurrency}`);
                const data = response.data.instrument;

                if (data) {
                    const mappedData = {
                        pair: pair,
                        maxLeverage: data.max_leverage || 20,
                        qtyStep: pair.includes('SUSHI') ? 1 : (data.quantity_step || 0.001),
                        priceStep: data.price_step || 0.01,
                        minNotional: data.min_notional || 6,
                        lastUpdated: new Date()
                    };

                    await Instrument.findOneAndUpdate(
                        { pair: pair },
                        mappedData,
                        { upsert: true, returnDocument: 'after' }
                    );
                    
                    this.instrumentCache.set(pair, mappedData);
                    console.log(`[InstrumentSync] ✅ Synced ${pair}: QtyStep:${mappedData.qtyStep}, MinNotional:${mappedData.minNotional}`);
                }
            } catch (err: any) {
                console.error(`[InstrumentSync] ❌ Failed to sync ${pair}:`, err.message);
            }
        }
    }

    static async getInstrumentDetails(pair: string) {
        if (this.instrumentCache.has(pair)) return this.instrumentCache.get(pair);

        try {
            const dbData = await Instrument.findOne({ pair });
            if (dbData) {
                this.instrumentCache.set(pair, dbData);
                return dbData;
            }
        } catch (err) {}

        // Ultimate Fallback if DB is empty (First time run)
        try {
            const marginCurrency = pair.includes('USDT') ? 'USDT' : 'INR';
            const response = await axios.get(`${this.baseUrl}/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=${marginCurrency}`);
            const data = response.data.instrument;
            if (data) {
                const mapped = {
                    pair: pair,
                    maxLeverage: data.max_leverage || 20,
                    qtyStep: pair.includes('SUSHI') ? 1 : (data.quantity_step || 0.001),
                    priceStep: data.price_step || 0.01,
                    minNotional: data.min_notional || 6
                };
                this.instrumentCache.set(pair, mapped);
                return mapped;
            }
        } catch (error: any) {
            console.error(`❌ Failed to fetch instrument details for ${pair}:`, error.message);
        }
        return { maxLeverage: 20, qtyStep: 0.001, priceStep: 0.01, minNotional: 6 }; // Emergency Fallback
    }

    static getInstrumentDetailsSync(pair: string) {
        if (this.instrumentCache.has(pair)) return this.instrumentCache.get(pair);
        return { maxLeverage: 20, qtyStep: 0.001, priceStep: 0.01, minNotional: 6 }; // Emergency Fallback
    }

    static async formatTradeParams(rawPair: string, rawQty: number, leverage: number, customTp: number = 0, customSl: number = 0, tradeDirection: string = 'buy', entryPrice: number = 0) {
        const pair = formatPair(rawPair);
        
        // 🎯 DYNAMIC DATA ONLY: Get latest constraints from DB
        const exchangeData = await this.getInstrumentDetails(pair);
        
        // 🎯 DYNAMIC LEVERAGE: Always use maximum leverage allowed by the exchange
        const leverageToUse = exchangeData.maxLeverage || 20;
        
        // 🎯 SAFETY GUARD: Ensure quantity and leverage are valid numbers
        const safeRawQty = (!rawQty || isNaN(rawQty) || !isFinite(rawQty)) ? 0.001 : rawQty;
        
        const step = exchangeData.qtyStep || 0.001;
        const qtyPrecision = step.toString().split('.')[1]?.length || 0;
        
        // 🎯 DIVISIBILITY GUARD: Ensure qty is a multiple of the exchange's step (e.g. 1.0 for SUSHI)
        let qty = Math.floor(safeRawQty / step) * step;

        // Enforce minimum quantity based on minimum notional requirement
        if (entryPrice > 0) {
             const minNotional = exchangeData.minNotional || 6;
             const minQty = Math.ceil((minNotional / entryPrice) / step) * step;
             if (qty < minQty) {
                 qty = minQty;
             }
        }

        // Final cleanup for floating point math errors
        qty = Number(qty.toFixed(qtyPrecision));

        const priceStep = exchangeData.priceStep || 0.01;
        const pricePrecision = priceStep.toString().split('.')[1]?.length || 0;
        
        let tpPrice = customTp > 0 ? Number(Number(customTp).toFixed(pricePrecision)) : 0;
        let slPrice = customSl > 0 ? Number(Number(customSl).toFixed(pricePrecision)) : 0;

        // 🛡️ SL/TP SAFETY GUARD: Ensure they are on the correct side and NOT equal to entry price
        if (entryPrice > 0) {
            const entryRounded = Number(entryPrice.toFixed(pricePrecision));
            
            if (tradeDirection.toLowerCase() === 'buy') {
                // SL must be BELOW entry
                if (slPrice >= entryRounded) {
                    slPrice = Number((entryRounded - priceStep).toFixed(pricePrecision));
                }
                // TP must be ABOVE entry
                if (tpPrice > 0 && tpPrice <= entryRounded) {
                    tpPrice = Number((entryRounded + priceStep).toFixed(pricePrecision));
                }
            } else {
                // SL must be ABOVE entry
                if (slPrice > 0 && slPrice <= entryRounded) {
                    slPrice = Number((entryRounded + priceStep).toFixed(pricePrecision));
                }
                // TP must be BELOW entry
                if (tpPrice > 0 && tpPrice >= entryRounded) {
                    tpPrice = Number((entryRounded - priceStep).toFixed(pricePrecision));
                }
            }
        }

        const marginName = pair.includes('USDT') ? 'USDT' : 'INR';

        return { pair, qty, maxLeverage: leverageToUse, tpPrice, slPrice, marginName };
    }

    static async executeFutureOrder(trade: Partial<Trade> & { pair?: string | undefined, leverage?: number | undefined, stop_loss_price?: number | undefined, take_profit_price?: number | undefined }) {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) {
            console.error("❌ CoinDCX API Key or Secret missing in .env.");
            return;
        }

        const settings = SettingsService.getSettings();
        const timeStamp = Math.floor(Date.now());

        console.log('[TradeService] 🔍 Incoming Trade:', JSON.stringify(trade, null, 2));

        const { pair, qty, maxLeverage, tpPrice, slPrice, marginName } = await this.formatTradeParams(
            trade.pair || settings.pair,
            Number(trade.units),
            trade.leverage || settings.leverage,
            Number(trade.take_profit_price || trade.tp || 0),
            Number(trade.stop_loss_price || trade.sl || 0),
            trade.direction || 'buy',
            trade.entryPrice || 0
        );

        console.log(`[TradeService] ⚙️ Formatted Params: Pair:${pair}, Qty:${qty}, Leverage:${maxLeverage}, TP:${tpPrice}, SL:${slPrice}`);

        const baseOrder: any = {
            side: trade.direction?.toLowerCase() || 'buy',
            pair: pair,
            order_type: "market_order",
            price: null,
            total_quantity: qty,
            leverage: maxLeverage,
            notification: "no_notification",
            time_in_force: null,
            margin_currency_short_name: marginName
        };

        if (tpPrice > 0) baseOrder.take_profit_price = tpPrice;
        if (slPrice > 0) baseOrder.stop_loss_price = slPrice;

        const body = {
            "timestamp": timeStamp,
            "order": baseOrder
        };

        console.log('[TradeService] 📦 Final Body:', JSON.stringify(body, null, 2));
        
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
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/positions/create_tpsl`, body, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });
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
            const response = await axios.get(`${this.baseUrl}/exchange/v1/derivatives/futures/wallets`, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                },
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
                const totalBalance = Number(marginBalance.balance);
                const { SettingsService } = await import('./SettingsService.js');
                await SettingsService.saveSettings({ bankBalance: totalBalance });
                return totalBalance;
            }
        }
        return null;
    }

    static async closePosition({positionId}:{positionId:string}) {
        const { apiKey, apiSecret } = this.credentials;
        if (!apiKey || !apiSecret) return;
        
        const timeStamp = Math.floor(Date.now()); 
        const body = {
            timestamp: timeStamp,
            id: positionId
        };
        const payload = Buffer.from(JSON.stringify(body)).toString();
        const signature = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');

        try {
            const response = await axios.post(`${this.baseUrl}/exchange/v1/derivatives/futures/positions/exit`, body, {
                headers: {
                    'X-AUTH-APIKEY': apiKey,
                    'X-AUTH-SIGNATURE': signature,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error: any) {
            console.error("❌ CoinDCX Trade Execution Failed:", error.response?.data || error.message);
            throw error;
        }
    }
}
