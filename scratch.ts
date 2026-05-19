import 'dotenv/config';
import crypto from 'crypto';
import axios from 'axios';

async function test() {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;
    const timeStamp = Math.floor(Date.now());
    const body = { timestamp: timeStamp };
    const bodyString = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', apiSecret!).update(bodyString).digest('hex');
    try {
        const response = await axios.post(`https://api.coindcx.com/exchange/v1/derivatives/futures/positions`, bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.log(e?.response?.data || e.message);
    }
}
test();
