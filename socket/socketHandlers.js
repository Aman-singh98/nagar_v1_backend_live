/**
 * @file socket/socketHandlers.js
 * @description Socket.IO connection and room management handlers. (F067, F066)
 *
 * Room strategy:
 *   Every socket joins two rooms on connect:
 *
 *   1. `company:{companyId}`
 *      — All users in the same company (employees + managers).
 *      — Managers receive `location:update` events broadcast to this room.
 *      — Ensures manager A never receives events for company B (isolation).
 *
 *   2. `employee:{employeeId}`  (employees only)
 *      — Personal room for targeting a specific employee.
 *      — Used for direct messages, commands, or individual status updates.
 *
 * @module socket/socketHandlers
 */

import { USER_ROLES } from '../models/user.model.js';
import {
   registerEmployeeSocket,
   unregisterEmployeeSocket,
   getConnectedEmployeeCount,
} from './connectionStateManager.js';

// ─── Room Name Helpers ────────────────────────────────────────────────────────

/** @param {string} companyId */
export const companyRoom = (companyId) => `company:${companyId}`;

/** @param {string} employeeId */
export const employeeRoom = (employeeId) => `employee:${employeeId}`;

// ─── Connection Handler ───────────────────────────────────────────────────────

/**
 * Handles a new authenticated socket connection.
 * Registers the socket middleware, joins rooms, and sets up disconnect handling.
 *
 * @param {import('socket.io').Socket} socket - Authenticated socket (socket.user is set)
 */
export const handleConnection = (socket) => {
   const { sub: userId, role, companyId, email } = socket.user;

   // ── Step 1: Join company room (all roles) ──────────────────────────────────
   // Managers receive location:update events broadcast to this room.
   socket.join(companyRoom(companyId));

   // ── Step 2: Join personal room (employees only) ───────────────────────────
   if (role === USER_ROLES.EMPLOYEE) {
      socket.join(employeeRoom(userId));
      registerEmployeeSocket(userId, socket.id);

      console.log(
         `[Socket] Employee connected | userId=${userId} email=${email}` +
         ` socketId=${socket.id} totalConnected=${getConnectedEmployeeCount()}`,
      );
   } else {
      console.log(
         `[Socket] ${role} connected | userId=${userId} email=${email} socketId=${socket.id}`,
      );
   }

   // ── Step 3: Acknowledge successful connection to the client ───────────────
   socket.emit('connection:ack', {
      socketId: socket.id,
      rooms: [...socket.rooms],
      timestamp: new Date().toISOString(),
   });

   // ── Step 4: Disconnect handler ────────────────────────────────────────────
   socket.on('disconnect', (reason) => {
      if (role === USER_ROLES.EMPLOYEE) {
         unregisterEmployeeSocket(userId);
         console.log(
            `[Socket] Employee disconnected | userId=${userId} reason=${reason}` +
            ` totalConnected=${getConnectedEmployeeCount()}`,
         );
      } else {
         console.log(
            `[Socket] ${role} disconnected | userId=${userId} reason=${reason}`,
         );
      }
   });

   // ── Step 5: Error handler — prevents unhandled error crashes ──────────────
   socket.on('error', (error) => {
      console.error(`[Socket] Error | socketId=${socket.id} error=${error.message}`);
   });
};
