import axios from 'axios';
import crypto from 'crypto';

export class TradeService {
    static async executeOrder(params: {
        apiKey: string,
        apiSecret: string,
        side: string,
        market: string,
        price: string,
        quantity: string
    }) {
        const timeStamp = Date.now();
        const body = {
            side: params.side,
            order_type: "market_order",
            market: params.market,
            price_per_unit: params.price,
            total_quantity: params.quantity,
            timestamp: timeStamp,
            client_order_id: `T-${timeStamp}`
        };

        const bodyString = JSON.stringify(body);
        const signature = crypto
            .createHmac('sha256', params.apiSecret)
            .update(bodyString)
            .digest('hex');

        const response = await axios.post('https://apigw.coindcx.com/exchange/v1/orders/create', bodyString, {
            headers: {
                'X-AUTH-APIKEY': params.apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }

    static async getBalances(apiKey: string, apiSecret: string) {
        const timeStamp = Date.now();
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(bodyString)
            .digest('hex');

        const response = await axios.post('https://api.coindcx.com/exchange/v1/users/balances', bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }
}
