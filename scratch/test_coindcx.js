const axios = require('axios');
axios.get('https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments').then(res => {
    const data = res.data;
    if (data && Array.isArray(data)) {
         const btc = data.find(d => d.pair.includes('BTC') && d.pair.includes('USDT'));
         console.log(JSON.stringify(btc, null, 2));
    } else {
        console.log(Object.keys(data));
        if (data.data) {
             const btc = data.data.find(d => d.pair.includes('BTC') && d.pair.includes('USDT'));
             console.log(JSON.stringify(btc, null, 2));
        }
    }
}).catch(e => console.error(e.response ? e.response.data : e.message));
