import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import routes from './routes/index.js';
import { SocketService } from './services/SocketService.js';

// Extend dayjs
dayjs.extend(utc);
dayjs.extend(timezone);

// Environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', routes);

// HTTP Server & Socket.IO
const server = http.createServer(app);
SocketService.init(server);

// Start server
// server.listen(PORT, () => {
server.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`🚀 Terminal Million Backend running on http://localhost:${PORT}`);
});
