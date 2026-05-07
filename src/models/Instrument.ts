import mongoose from 'mongoose';

export interface IInstrument {
    pair: string;
    maxLeverage: number;
    qtyStep: number;
    priceStep: number;
    minNotional: number;
    lastUpdated: Date;
}

const InstrumentSchema = new mongoose.Schema<IInstrument>({
    pair: { type: String, required: true, unique: true },
    maxLeverage: { type: Number, required: true },
    qtyStep: { type: Number, required: true },
    priceStep: { type: Number, required: true },
    minNotional: { type: Number, required: true, default: 6 },
    lastUpdated: { type: Date, default: Date.now }
});

export const Instrument = mongoose.model<IInstrument>('Instrument', InstrumentSchema);
