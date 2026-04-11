import express from 'express';
import cors from 'cors';
import http from 'http';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import routes from './routes/index.js';
import { SocketService } from './services/SocketService.js';
import { SettingsService } from './services/SettingsService.js';
import mongoose from 'mongoose';
import { MONGODB_URI } from './config/constants.js';

// Extend dayjs
dayjs.extend(utc);
dayjs.extend(timezone);

mongoose.set('bufferCommands', false);

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', routes);

// HTTP Server & Socket.IO
const server = http.createServer(app);

// Start server
const start = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ MongoDB Connected to Atlas');
        
        // Initialize settings
        await SettingsService.init();

        // Start services
        SocketService.init(server);
        
        server.listen(Number(PORT), "0.0.0.0", () => {
            console.log(`🚀 Terminal Million Backend running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
        process.exit(1);
    }
};

start();
