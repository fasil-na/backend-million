import mongoose from 'mongoose';
async function run() {
    await mongoose.connect('mongodb://127.0.0.1:27017/million-bot');
    const TradeSchema = new mongoose.Schema({ type: String, status: String });
    const Trade = mongoose.model('TestTrade', TradeSchema);
    await Trade.deleteMany({});
    await Trade.create({ type: 'real', status: 'open' });
    await Trade.create({ type: 'paper', status: 'open' });
    await Trade.create({ type: 'real', status: 'closed' });
    await Trade.create({ type: 'paper', status: 'closed' });
    
    await Trade.deleteMany({
        type: { $ne: 'real' },
        status: { $ne: 'open' }
    });
    
    const remaining = await Trade.find({}).lean();
    console.log("Remaining:", remaining);
    process.exit(0);
}
run();
