/**
 * @file services/minStayEngine.js
 * @description Minimum stay validation engine. (F045, F046, F047, F048)
 *
 * This is the core correctness feature for Week 15.
 * It processes every incoming GPS point and:
 *   1. Detects ENTRY into a geofence (previous state: outside → now: inside)
 *   2. Detects EXIT from a geofence (previous state: inside → now: outside)
 *   3. On EXIT: validates durationSeconds >= route.minStaySeconds
 *   4. On valid stay: marks center as VISITED
 *   5. On invalid stay (drive-through): resets to PENDING
 *   6. Emits 'visit:updated' socket event in both cases
 *   7. Flags out-of-sequence visits (F048)
 *
 * Flow per GPS point:
 *
 *   for each unvisited center:
 *     distance = haversineDistance(point, center)
 *     isInside = distance <= center.radius
 *     prevState = geofenceStateManager.get(employee, assignment, center)
 *
 *     ENTRY: !prevState.inside && isInside
 *       → recordEntry, set status = IN_ZONE
 *
 *     INSIDE: prevState.inside && isInside
 *       → no state change, employee still in zone
 *
 *     EXIT: prevState.inside && !isInside
 *       → calculate durationSeconds
 *       → if duration >= minStaySeconds → VISITED
 *       → if duration <  minStaySeconds → PENDING (drive-through rejected)
 *       → emit visit:updated
 *
 *     OUTSIDE: !prevState.inside && !isInside
 *       → no state change
 *
 * @module services/minStayEngine
 */

import Assignment, { ASSIGNMENT_STATUS, VISIT_STATUS } from '../models/assignment.model.js';
import { haversineDistance } from './geofence.service.js';
import {
   getGeofenceState,
   recordGeofenceEntry,
   recordGeofenceExit,
   clearAssignmentState,
} from './geofenceStateManager.js';
import { getIO } from '../socket/socketManager.js';
import { companyRoom } from '../socket/socketHandlers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   assignment: import('mongoose').Document,
 *   point: { lat: number, lng: number },
 *   serverTime: Date,
 *   employeeId: string,
 *   companyId: string,
 *   minStaySeconds: number,
 * }} ProcessPointParams
 */

/**
 * @typedef {{
 *   centerId: string,
 *   centerName: string,
 *   event: 'entry' | 'exit_valid' | 'exit_rejected' | 'none',
 *   durationSeconds?: number,
 *   status: string,
 * }} CenterEvent
 */

// ─── Main Engine ──────────────────────────────────────────────────────────────

/**
 * Processes a single GPS point through the minimum stay engine.
 * Detects entry/exit events and validates minimum stay duration on exit.
 *
 * @param {ProcessPointParams} params
 * @returns {Promise<CenterEvent[]>} Array of events that occurred this point
 */
export const processGpsPoint = async ({
   assignment,
   point,
   serverTime,
   employeeId,
   companyId,
   minStaySeconds,
}) => {
   const centers = assignment.routeId?.centers ?? [];
   const events = [];
   const updateFields = {};
   let needsDbWrite = false;

   // Get sorted centers for out-of-sequence detection (F048)
   const sortedCenters = [...centers].sort((a, b) => a.order - b.order);
   const visitedCount = assignment.visitStatuses.filter(
      (vs) => vs.status === VISIT_STATUS.VISITED,
   ).length;

   for (const center of centers) {
      const centerIdStr = String(center._id);

      // Find visitStatus index for this center
      const vsIndex = assignment.visitStatuses.findIndex(
         (vs) => String(vs.centerId) === centerIdStr,
      );
      if (vsIndex === -1) continue;

      const vs = assignment.visitStatuses[vsIndex];

      // Skip already visited or skipped centers
      if (vs.status === VISIT_STATUS.VISITED || vs.status === VISIT_STATUS.SKIPPED) continue;

      // Calculate distance to center
      const distance = haversineDistance(point.lat, point.lng, center.lat, center.lng);
      const isInsideNow = distance <= center.radius;

      // Get previous geofence state
      const prevState = getGeofenceState(employeeId, String(assignment._id), centerIdStr);

      // ── ENTRY detected ────────────────────────────────────────────────────────
      if (!prevState.inside && isInsideNow) {
         recordGeofenceEntry(employeeId, String(assignment._id), centerIdStr, serverTime);

         // ── Out-of-sequence detection (F048) ───────────────────────────────────
         const expectedOrder = sortedCenters[visitedCount]?.order;
         const isOutOfSequence = center.order !== expectedOrder;

         // Set status to IN_ZONE — employee is inside but min stay not yet met
         updateFields[`visitStatuses.${vsIndex}.status`] = VISIT_STATUS.IN_ZONE;
         updateFields[`visitStatuses.${vsIndex}.entryTimestamp`] = serverTime;
         updateFields[`visitStatuses.${vsIndex}.outOfSequence`] = isOutOfSequence;
         needsDbWrite = true;

         events.push({
            centerId: centerIdStr,
            centerName: center.name,
            event: 'entry',
            status: VISIT_STATUS.IN_ZONE,
         });

         // Emit entry event to dashboard
         emitVisitEvent(companyId, {
            assignmentId: String(assignment._id),
            centerId: centerIdStr,
            centerName: center.name,
            status: VISIT_STATUS.IN_ZONE,
            employeeId,
            outOfSequence: isOutOfSequence,
            timestamp: serverTime.toISOString(),
         });
      }

      // ── EXIT detected ─────────────────────────────────────────────────────────
      else if (prevState.inside && !isInsideNow) {
         recordGeofenceExit(employeeId, String(assignment._id), centerIdStr);

         const entryTime = prevState.entryTime ?? serverTime;
         const durationSeconds = Math.round((serverTime - entryTime) / 1000);

         updateFields[`visitStatuses.${vsIndex}.exitTimestamp`] = serverTime;
         updateFields[`visitStatuses.${vsIndex}.durationSeconds`] = durationSeconds;
         needsDbWrite = true;

         if (durationSeconds >= minStaySeconds) {
            // ── Valid stay → VISITED ───────────────────────────────────────────
            updateFields[`visitStatuses.${vsIndex}.status`] = VISIT_STATUS.VISITED;
            updateFields[`visitStatuses.${vsIndex}.visitedAt`] = serverTime;

            // Set startedAt on first visit
            if (!assignment.startedAt) {
               updateFields.startedAt = serverTime;
               updateFields.status = ASSIGNMENT_STATUS.IN_PROGRESS;
            }

            events.push({
               centerId: centerIdStr,
               centerName: center.name,
               event: 'exit_valid',
               durationSeconds,
               status: VISIT_STATUS.VISITED,
            });

            emitVisitEvent(companyId, {
               assignmentId: String(assignment._id),
               centerId: centerIdStr,
               centerName: center.name,
               status: VISIT_STATUS.VISITED,
               durationSeconds,
               employeeId,
               visitedAt: serverTime.toISOString(),
               timestamp: serverTime.toISOString(),
            });

            console.log(
               `[MinStay] ✅ VISITED center=${center.name} duration=${durationSeconds}s` +
               ` required=${minStaySeconds}s`,
            );
         } else {
            // ── Drive-through → reset to PENDING ──────────────────────────────
            updateFields[`visitStatuses.${vsIndex}.status`] = VISIT_STATUS.PENDING;
            updateFields[`visitStatuses.${vsIndex}.entryTimestamp`] = null;
            updateFields[`visitStatuses.${vsIndex}.exitTimestamp`] = null;

            events.push({
               centerId: centerIdStr,
               centerName: center.name,
               event: 'exit_rejected',
               durationSeconds,
               status: VISIT_STATUS.PENDING,
            });

            emitVisitEvent(companyId, {
               assignmentId: String(assignment._id),
               centerId: centerIdStr,
               centerName: center.name,
               status: VISIT_STATUS.PENDING,
               durationSeconds,
               employeeId,
               rejected: true,
               rejectionReason: `Minimum stay not met: ${durationSeconds}s / ${minStaySeconds}s required`,
               timestamp: serverTime.toISOString(),
            });

            console.log(
               `[MinStay] ❌ REJECTED drive-through center=${center.name}` +
               ` duration=${durationSeconds}s required=${minStaySeconds}s`,
            );
         }
      }
   }

   // ── Single DB write for all state changes this point ──────────────────────
   if (needsDbWrite && Object.keys(updateFields).length > 0) {
      // Check if assignment is now complete
      const updatedAssignment = await checkAndApplyCompletion(
         assignment,
         updateFields,
      );

      if (updatedAssignment?.status === ASSIGNMENT_STATUS.COMPLETED) {
         clearAssignmentState(String(assignment._id));
      }
   }

   return events;
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Applies all accumulated updateFields to the Assignment document.
 * Checks if the assignment is now complete after this batch of updates.
 *
 * @param {import('mongoose').Document} assignment
 * @param {Record<string, unknown>} updateFields
 * @returns {Promise<import('mongoose').Document | null>}
 */
const checkAndApplyCompletion = async (assignment, updateFields) => {
   // Simulate post-update visit statuses to check completion
   const simulatedStatuses = assignment.visitStatuses.map((vs, i) => {
      const statusKey = `visitStatuses.${i}.status`;
      return updateFields[statusKey] ?? vs.status;
   });

   const allResolved = simulatedStatuses.every(
      (s) => s === VISIT_STATUS.VISITED || s === VISIT_STATUS.SKIPPED,
   );

   if (allResolved && !assignment.completedAt) {
      updateFields.status = ASSIGNMENT_STATUS.COMPLETED;
      updateFields.completedAt = new Date();
   }

   return Assignment.findByIdAndUpdate(
      assignment._id,
      { $set: updateFields },
      { new: true, runValidators: false },
   );
};

/**
 * Emits a 'visit:updated' event to the company room.
 * Fire-and-forget — never blocks the processing pipeline.
 *
 * @param {string} companyId
 * @param {object} payload
 */
const emitVisitEvent = (companyId, payload) => {
   try {
      getIO().to(companyRoom(companyId)).emit('visit:updated', payload);
   } catch (err) {
      console.error('[MinStay] Socket emit failed:', err.message);
   }
};
