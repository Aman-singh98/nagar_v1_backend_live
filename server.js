/**
 * @file server.js
 * @description Application entry point — DB connection, HTTP server, and Socket.IO startup.
 *
 * Responsibilities:
 *  1. Validate required environment variables before anything else runs.
 *  2. Connect to MongoDB.
 *  3. Create HTTP server from Express app.
 *  4. Initialise Socket.IO on the HTTP server.
 *  5. Register socket middleware and connection handlers.
 *  6. Start listening.
 *  7. Handle uncaught exceptions and unhandled rejections.
 *
 * Why HTTP server instead of app.listen()?
 *   Socket.IO must attach to the raw Node.js HTTP server — not the Express app.
 *   createServer(app) gives us that handle while keeping the Express app testable.
 */

import { createServer } from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import app from './app.js';
import { initIO } from './socket/socketManager.js';
import { socketAuthMiddleware } from './socket/socketAuth.middleware.js';
import { handleConnection } from './socket/socketHandlers.js';
import { initTrackingOffCron } from './jobs/trackingOffCron.js';
import { initFirebaseAdmin } from './services/firebaseAdmin.js';

dotenv.config();

const REQUIRED_ENV_VARS = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
REQUIRED_ENV_VARS.forEach((key) => {
   if (!process.env[key]) { console.error(`❌  Missing: ${key}`); process.exit(1); }
});

const PORT = process.env.PORT || 5000;

process.on('uncaughtException', (e) => { console.error('❌  UNCAUGHT:', e); process.exit(1); });
process.on('unhandledRejection', (r) => { console.error('❌  UNHANDLED:', r); process.exit(1); });

const startServer = async () => {
   try {
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log('✅  MongoDB connected');

      initFirebaseAdmin();

      const httpServer = createServer(app);
      const io = initIO(httpServer);
      io.use(socketAuthMiddleware);
      io.on('connection', handleConnection);

      // ── Start cron jobs ──────────────────────────────────────────────────────
      initTrackingOffCron();

      httpServer.listen(PORT, () => {
         console.log(`🚀  Server running on port ${PORT}`);
         console.log(`📡  Health → http://localhost:${PORT}/health`);
         console.log(`🔌  Socket.IO ready on ws://localhost:${PORT}`);
      });
   } catch (err) {
      console.error('❌  Startup error:', err.message);
      process.exit(1);
   }
};

startServer();
