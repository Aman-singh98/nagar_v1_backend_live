/**
 * @file services/employeeActivityTracker.js
 * @description In-memory last-seen timestamp tracker for TrackingOff detection. (F071)
 *
 * Single Responsibility: records and exposes the last GPS ping time per employee.
 * The cron job uses this to detect employees who have gone silent.
 *
 * Storage: plain JS Map — O(1) get/set, zero external dependency.
 *
 * Scale note: For multiple Node.js instances, replace with Redis HSET/HGET.
 * Key: employeeId, Value: ISO timestamp string. TTL: 24 hours.
 *
 * @module services/employeeActivityTracker
 */

/**
 * Map<employeeId: string, lastSeenAt: Date>
 */
const _lastSeenMap = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Records that an employee sent a GPS ping right now.
 * Called on every successful POST /locations.
 *
 * @param {string} employeeId
 */
export const recordEmployeeActivity = (employeeId) => {
   _lastSeenMap.set(String(employeeId), new Date());
};

/**
 * Returns the last time an employee sent a GPS ping.
 * Returns null if no activity has been recorded.
 *
 * @param {string} employeeId
 * @returns {Date | null}
 */
export const getLastSeenAt = (employeeId) => {
   return _lastSeenMap.get(String(employeeId)) ?? null;
};

/**
 * Returns all tracked employees and their last seen timestamps.
 * Used by the cron job to check all active employees at once.
 *
 * @returns {Array<{ employeeId: string, lastSeenAt: Date }>}
 */
export const getAllTrackedEmployees = () => {
   return Array.from(_lastSeenMap.entries()).map(([employeeId, lastSeenAt]) => ({
      employeeId,
      lastSeenAt,
   }));
};

/**
 * Removes an employee from the tracker.
 * Call when an assignment ends or employee logs out.
 *
 * @param {string} employeeId
 */
export const removeEmployeeActivity = (employeeId) => {
   _lastSeenMap.delete(String(employeeId));
};

/**
 * Returns the total number of tracked employees.
 * Used for monitoring.
 *
 * @returns {number}
 */
export const getTrackedEmployeeCount = () => _lastSeenMap.size;
