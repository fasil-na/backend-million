import axios from 'axios';
import { COINDCX_URL } from '../config/constants.js';

export class CoinDCXApiService {
    static async getInstrumentLeverage(pair: string): Promise<number> {
        try {
            const url = `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=USDT`;
            const response = await axios.get(url);
            if (response.data && response.data.instrument) {
                return response.data.instrument.max_leverage_long || 1;
            }
            return 1;
        } catch (error) {
            console.error(`Failed to fetch leverage for ${pair}:`, error);
            return 1;
        }
    }

    static async getMarketDetails(pair: string) {
        const response = await axios.get('https://apigw.coindcx.com/exchange/v1/markets_details');
        return response.data.find((m: any) => m.coindcx_name === (pair || 'DOGEINR'));
    }

    static async getCandlesticks(params: any) {
        const response = await axios.get(COINDCX_URL, { params: { ...params, pcode: 'f' } });
        return response.data;
    }
}
