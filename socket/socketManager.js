/**
 * @file socket/socketManager.js
 * @description Socket.IO singleton manager.
 *
 * Single Responsibility: owns the Socket.IO server instance and exposes
 * a clean API for the rest of the application to emit events without
 * importing the io instance directly from server.js.
 *
 * Pattern: Module-level singleton — initialised once in server.js,
 * accessed everywhere via getIO(). This avoids circular imports between
 * server.js → app.js → controllers → socketManager.
 *
 * Usage:
 *   // In server.js (once):
 *   initIO(httpServer);
 *
 *   // In any controller:
 *   const { getIO } = require('./socket/socketManager.js');
 *   getIO().to(`company:${companyId}`).emit('location:update', payload);
 *
 * @module socket/socketManager
 */

import { Server } from 'socket.io';

/** @type {import('socket.io').Server | null} */
let _io = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialises the Socket.IO singleton. Must be called ONCE in server.js
 * after the HTTP server is created.
 *
 * @param {import('http').Server} httpServer - The Node.js HTTP server instance.
 * @param {import('socket.io').ServerOptions} [options] - Optional Socket.IO config.
 * @returns {import('socket.io').Server}
 */
export const initIO = (httpServer, options = {}) => {
   if (_io) {
      console.warn('[SocketManager] initIO called more than once — ignoring.');
      return _io;
   }

   // const { Server } = await import('socket.io');

   _io = new Server(httpServer, {
      cors: {
         origin: process.env.CORS_ORIGIN?.split(',') || 'http://localhost:5173',
         credentials: true,
      },
      // Ping timeout / interval for stale connection detection (F066)
      pingTimeout: 20_000,   // 20s — close connection if no pong received
      pingInterval: 25_000,  // 25s — send ping every 25s
      ...options,
   });

   console.log('✅  Socket.IO initialised');
   return _io;
};

// ─── Accessor ─────────────────────────────────────────────────────────────────

/**
 * Returns the initialised Socket.IO server instance.
 * Throws if called before initIO() — prevents silent null-reference bugs.
 *
 * @returns {import('socket.io').Server}
 * @throws {Error} If called before initIO()
 */
export const getIO = () => {
   if (!_io) {
      throw new Error(
         '[SocketManager] Socket.IO is not initialised. Call initIO(httpServer) in server.js first.',
      );
   }
   return _io;
};
