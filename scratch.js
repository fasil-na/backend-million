import { CoinDCXApiService } from './src/services/CoinDCXApiService.js';
const now = Math.floor(Date.now() / 1000);
CoinDCXApiService.getCandlesticks({ pair: 'B-BTC_USDT', resolution: '1', from: now - 150000, to: now }).then(res => console.log(res.data ? res.data.length : 'error'));
