require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

async function test() {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;
    const timeStamp = Math.floor(Date.now());
    
    // First, let's test if there's a cancel_all endpoint
    try {
        // Many exchanges just use /cancel_all
        const body = { timestamp: timeStamp, pair: "B-BTC_USDT" };
        const bodyString = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', apiSecret).update(bodyString).digest('hex');
        
        const response = await axios.post(`https://api.coindcx.com/exchange/v1/derivatives/futures/orders/cancel_all`, bodyString, {
            headers: {
                'X-AUTH-APIKEY': apiKey,
                'X-AUTH-SIGNATURE': signature,
                'Content-Type': 'application/json'
            }
        });
        console.log("CANCEL ALL RESPONSE:");
        console.log(JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.log("Cancel All failed:", e?.response?.data || e.message);
        
        // Let's try just cancelling a specific order if we can find one.
        // What is the open order from scratch2?
        // Wait, scratch2 output didn't show any OPEN orders, they were all "filled" or "cancelled".
    }
}
test();
