/**
 * @file services/geofenceStateManager.js
 * @description In-memory geofence state tracker. (F047)
 *
 * Single Responsibility: tracks whether each employee is currently inside
 * or outside each center's geofence, and when they entered.
 *
 * This is the state required to detect ENTRY and EXIT events from a stream
 * of raw GPS points — each point alone cannot tell you if an employee just
 * entered or just left a geofence. You need the previous state.
 *
 * State key: `{employeeId}:{assignmentId}:{centerId}`
 * State value: { inside: boolean, entryTime: Date | null }
 *
 * Storage: plain JS Map — O(1) get/set, no external dependency.
 *
 * Scale note: For horizontal scaling (multiple Node.js processes), replace
 * the Map with Redis HSET/HGET. The interface is identical — only this file
 * changes. Redis key TTL of 24 hours prevents stale state accumulation.
 *
 * @module services/geofenceStateManager
 */

/**
 * @typedef {{ inside: boolean, entryTime: Date | null }} GeofenceState
 */

/** @type {Map<string, GeofenceState>} */
const _stateMap = new Map();

// ─── Key Builder ──────────────────────────────────────────────────────────────

/**
 * Builds a composite key for the state map.
 * Format: `emp:{employeeId}:asgn:{assignmentId}:ctr:{centerId}`
 *
 * @param {string} employeeId
 * @param {string} assignmentId
 * @param {string} centerId
 * @returns {string}
 */
const buildKey = (employeeId, assignmentId, centerId) =>
   `emp:${employeeId}:asgn:${assignmentId}:ctr:${centerId}`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the current geofence state for an employee at a specific center.
 * Returns { inside: false, entryTime: null } if no state exists yet.
 *
 * @param {string} employeeId
 * @param {string} assignmentId
 * @param {string} centerId
 * @returns {GeofenceState}
 */
export const getGeofenceState = (employeeId, assignmentId, centerId) => {
   const key = buildKey(employeeId, assignmentId, centerId);
   return _stateMap.get(key) ?? { inside: false, entryTime: null };
};

/**
 * Records that an employee entered a center's geofence.
 * Sets inside: true and records the entry timestamp.
 *
 * @param {string} employeeId
 * @param {string} assignmentId
 * @param {string} centerId
 * @param {Date}   entryTime
 */
export const recordGeofenceEntry = (employeeId, assignmentId, centerId, entryTime) => {
   const key = buildKey(employeeId, assignmentId, centerId);
   _stateMap.set(key, { inside: true, entryTime });
};

/**
 * Records that an employee exited a center's geofence.
 * Sets inside: false but preserves entryTime for duration calculation.
 *
 * @param {string} employeeId
 * @param {string} assignmentId
 * @param {string} centerId
 */
export const recordGeofenceExit = (employeeId, assignmentId, centerId) => {
   const key = buildKey(employeeId, assignmentId, centerId);
   const existing = _stateMap.get(key);
   _stateMap.set(key, { inside: false, entryTime: existing?.entryTime ?? null });
};

/**
 * Clears all geofence state for a specific assignment.
 * Call when an assignment is completed or ended to free memory.
 *
 * @param {string} assignmentId
 */
export const clearAssignmentState = (assignmentId) => {
   for (const key of _stateMap.keys()) {
      if (key.includes(`asgn:${assignmentId}`)) {
         _stateMap.delete(key);
      }
   }
};

/**
 * Returns the total number of tracked states.
 * Used for monitoring / health checks.
 *
 * @returns {number}
 */
export const getTrackedStateCount = () => _stateMap.size;
