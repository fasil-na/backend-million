require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

async function test() {
    const apiKey = process.env.COINDCX_API_KEY;
    const apiSecret = process.env.COINDCX_API_SECRET;
    const timeStamp = Math.floor(Date.now());
    
    try {
        // Fetch orders first to find an open one
        const bodyOrders = { timestamp: timeStamp };
        const bodyStringOrders = JSON.stringify(bodyOrders);
        const signatureOrders = crypto.createHmac('sha256', apiSecret).update(bodyStringOrders).digest('hex');
        
        const responseOrders = await axios.post(`https://api.coindcx.com/exchange/v1/derivatives/futures/orders`, bodyStringOrders, {
            headers: { 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': signatureOrders, 'Content-Type': 'application/json' }
        });
        
        const openOrder = responseOrders.data.find(o => o.status === 'open' && o.order_type === 'limit_order');
        if (!openOrder) {
            console.log("No open limit orders found to cancel.");
            return;
        }
        
        console.log(`Found open limit order: ${openOrder.id}. Cancelling...`);
        
        const cancelBody = { timestamp: Math.floor(Date.now()), id: openOrder.id };
        const cancelBodyString = JSON.stringify(cancelBody);
        const cancelSignature = crypto.createHmac('sha256', apiSecret).update(cancelBodyString).digest('hex');
        
        const responseCancel = await axios.post(`https://api.coindcx.com/exchange/v1/derivatives/futures/orders/cancel`, cancelBodyString, {
            headers: { 'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': cancelSignature, 'Content-Type': 'application/json' }
        });
        
        console.log("CANCEL RESPONSE:", responseCancel.data);
    } catch (e) {
        console.log("Error:", e?.response?.data || e.message);
    }
}
test();
