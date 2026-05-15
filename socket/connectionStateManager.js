/**
 * @file socket/connectionStateManager.js
 * @description In-memory connection state manager. (F066)
 *
 * Single Responsibility: tracks the last known socket ID per employee.
 * Used to detect stale connections and handle reconnection gracefully.
 *
 * Storage: plain JS Map — fast O(1) lookups, no external dependency.
 * Limitation: not shared across multiple server instances. If horizontal
 * scaling is needed in future, replace with Redis (HSET/HGET on employeeId).
 *
 * @module socket/connectionStateManager
 */

/**
 * Map<employeeId: string, socketId: string>
 * Stores the most recent socket ID for each connected employee.
 */
const _employeeSocketMap = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Registers or updates the socket ID for an employee.
 * Called on socket connect and reconnect.
 *
 * @param {string} employeeId
 * @param {string} socketId
 */
export const registerEmployeeSocket = (employeeId, socketId) => {
   _employeeSocketMap.set(employeeId, socketId);
};

/**
 * Removes the socket registration for an employee.
 * Called on socket disconnect.
 *
 * @param {string} employeeId
 */
export const unregisterEmployeeSocket = (employeeId) => {
   _employeeSocketMap.delete(employeeId);
};

/**
 * Returns the last known socket ID for an employee.
 * Returns undefined if the employee is not connected.
 *
 * @param {string} employeeId
 * @returns {string | undefined}
 */
export const getEmployeeSocketId = (employeeId) => {
   return _employeeSocketMap.get(employeeId);
};

/**
 * Returns whether an employee currently has an active socket connection.
 *
 * @param {string} employeeId
 * @returns {boolean}
 */
export const isEmployeeConnected = (employeeId) => {
   return _employeeSocketMap.has(employeeId);
};

/**
 * Returns the total number of connected employees.
 * Used for monitoring and logging.
 *
 * @returns {number}
 */
export const getConnectedEmployeeCount = () => {
   return _employeeSocketMap.size;
};
