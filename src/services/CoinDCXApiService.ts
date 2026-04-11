import axios from 'axios';
import { COINDCX_URL } from '../config/constants.js';
import { formatPair } from '../strategies/StrategyUtils.js';

export class CoinDCXApiService {
    static async getInstrumentLeverage(pair: string): Promise<number> {
        try {
            const formattedPair = formatPair(pair);
            const url = `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=${formattedPair}&margin_currency_short_name=USDT`;
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
        const { pair, ...rest } = params;
        const formattedPair = formatPair(pair);
        const response = await axios.get(COINDCX_URL, { params: { ...rest, pair: formattedPair, pcode: 'f' } });
        
        if (response.data && Array.isArray(response.data.data)) {
            response.data.data = response.data.data.map((c: any) => ({
                ...c,
                time: c.time < 10000000000 ? c.time * 1000 : c.time
            }));
        }
        
        return response.data;
    }
}
