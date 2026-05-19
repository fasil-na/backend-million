require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

async function test() {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;
    const timeStamp = Math.floor(Date.now());
    
    // First, let's GET open orders to see what the pair name is
    try {
        const body = { timestamp: timeStamp };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');
        
        const response = await axios.post(`https://api.coindcx.com/exchange/v1/derivatives/futures/orders`, bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });
        console.log("OPEN ORDERS:");
        console.log(JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.log("Error getting orders:", e?.response?.data || e.message);
    }
}
test();
