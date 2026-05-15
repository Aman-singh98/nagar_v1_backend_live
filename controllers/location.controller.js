/**
 * @file location.controller.js
 * @description HTTP handlers for GPS location ingestion and retrieval.
 *
 *  - ingestLocation now uses minStayEngine.processGpsPoint() instead of
 *    the old checkGeofences/applyGeofenceHits pipeline.
 *  - Loads route.minStaySeconds for minimum stay validation.
 *  - Returns minStayEvents in response so mobile app knows entry/exit state.
 *  - old geofence imports removed — minStayEngine handles all geofence logic.
 *
 * Socket.IO integration:
 *  - After every location ingest, emits 'location:update' to company room.
 *  - minStayEngine emits 'visit:updated' on entry/exit events.
 * 
 *  - recordEmployeeActivity() called on every ingestLocation (TrackingOff detection)
 *  - endAssignment now creates MissedCenter alerts (F068)
 *  - endAssignment emits visit:updated for skipped centers
 *
 * @module controllers/location
 */

/**
 * @file location.controller.js
 * @description HTTP handlers for GPS location ingestion and retrieval.
 *
 * Week 16 additions:
 *  - recordEmployeeActivity() called on every ingestLocation (TrackingOff detection)
 *  - endAssignment now creates MissedCenter alerts (F068)
 *  - endAssignment emits visit:updated for skipped centers
 *
 * @module controllers/location
 */

import mongoose from 'mongoose';
import LocationLog from '../models/locationLog.model.js';
import Assignment, { ASSIGNMENT_STATUS, VISIT_STATUS } from '../models/assignment.model.js';
import User from '../models/user.model.js';
import AppError from '../utils/appError.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { paginateQuery } from '../utils/pagination.js';
import { USER_ROLES } from '../models/user.model.js';
import { validateGpsPoint } from '../services/geofence.service.js';
import { processGpsPoint } from '../services/minStayEngine.js';
import { recordEmployeeActivity } from '../services/employeeActivityTracker.js';
import { createMissedCenterAlerts } from '../services/alertService.js';
import { getIO } from '../socket/socketManager.js';
import { companyRoom } from '../socket/socketHandlers.js';

// ─── POST /locations ──────────────────────────────────────────────────────────

/**
 * Ingests a single GPS point from the mobile app.
 *
 * Pipeline:
 *  1. Load assignment with route centers + minStaySeconds
 *  2. Validate GPS point quality
 *  3. Insert LocationLog (fire-and-forget)
 *  4. Emit 'location:update' to dashboard via Socket.IO (fire-and-forget)
 *  5. Record employee activity for TrackingOff detection (Week 16)
 *  6. Run min stay engine
 *  7. Respond with minStayEvents summary
 *
 * @type {import('express').RequestHandler}
 */
export const ingestLocation = async (req, res, next) => {
   try {
      const {
         assignmentId, lat, lng, accuracy,
         speed, altitude, heading, timestamp,
         pointId,
      } = req.body;

      const serverTime = new Date();

      // ── Step 1: Load assignment ──────────────────────────────────────────────
      const assignment = await Assignment
         .findOne({
            _id: assignmentId,
            employeeId: req.user.sub,
            companyId: req.user.companyId,
            status: { $in: [ASSIGNMENT_STATUS.PENDING, ASSIGNMENT_STATUS.IN_PROGRESS] },
         })
         .populate('routeId', 'centers minStaySeconds')
         .lean(false);

      if (!assignment) {
         return next(new AppError(
            'Assignment not found, already completed, or does not belong to you.',
            404,
         ));
      }

      // ── Step 2: Validate GPS quality ─────────────────────────────────────────
      const { valid, reason } = validateGpsPoint({ lat, lng, accuracy });

      // ── Step 3: Fire-and-forget LocationLog insert ───────────────────────────
      LocationLog.create({
         pointId: pointId ?? null,
         employeeId: new mongoose.Types.ObjectId(req.user.sub),
         assignmentId: new mongoose.Types.ObjectId(assignmentId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         lat, lng, accuracy, speed, altitude, heading,
         timestamp: timestamp ? new Date(timestamp) : serverTime,
         serverTime,
         synced: true,
      }).catch((err) => {
         if (err?.code !== 11000) {
            console.error(`[LocationLog] Insert failed for assignment ${assignmentId}:`, err.message);
         }
      });

      // ── Step 4: Emit real-time location update to dashboard ──────────────────
      emitLocationUpdate({
         companyId: req.user.companyId,
         employeeId: req.user.sub,
         lat, lng, accuracy, speed,
         timestamp: timestamp ?? serverTime.toISOString(),
      });

      // ── Step 5: Record activity for TrackingOff cron detection (F071) ────────
      recordEmployeeActivity(req.user.sub);

      // ── Step 6: Skip geofence if GPS quality too low ─────────────────────────
      if (!valid) {
         return sendSuccess(res, 200, 'Location received. Geofence skipped (low accuracy).', {
            minStayEvents: [],
            skippedReason: reason,
         });
      }

      // ── Step 7: Min stay engine ───────────────────────────────────────────────
      const minStaySeconds = assignment.routeId?.minStaySeconds ?? 300;

      const minStayEvents = await processGpsPoint({
         assignment,
         point: { lat, lng },
         serverTime,
         employeeId: req.user.sub,
         companyId: req.user.companyId,
         minStaySeconds,
      });

      // ── Step 8: Respond ──────────────────────────────────────────────────────
      return sendSuccess(res, 200, 'Location received.', {
         minStayEvents: minStayEvents.map((e) => ({
            centerId: e.centerId,
            centerName: e.centerName,
            event: e.event,
            durationSeconds: e.durationSeconds ?? null,
            status: e.status,
         })),
      });
   } catch (error) {
      return next(error);
   }
};

// ─── POST /locations/batch ────────────────────────────────────────────────────

/**
 * Ingests a batch of GPS points collected while offline.
 * @type {import('express').RequestHandler}
 */
export const ingestBatch = async (req, res, next) => {
   try {
      const { assignmentId, points } = req.body;
      const serverTime = new Date();

      const assignment = await Assignment
         .findOne({
            _id: assignmentId,
            employeeId: req.user.sub,
            companyId: req.user.companyId,
            status: {
               $in: [
                  ASSIGNMENT_STATUS.PENDING,
                  ASSIGNMENT_STATUS.IN_PROGRESS,
                  ASSIGNMENT_STATUS.COMPLETED,
               ],
            },
         })
         .populate('routeId', 'centers minStaySeconds')
         .lean(false);

      if (!assignment) {
         return next(new AppError('Assignment not found or does not belong to you.', 404));
      }

      const sorted = [...points].sort(
         (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
      );

      const logDocs = sorted.map((p) => ({
         pointId: p.pointId ?? null,
         employeeId: new mongoose.Types.ObjectId(req.user.sub),
         assignmentId: new mongoose.Types.ObjectId(assignmentId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         lat: p.lat, lng: p.lng,
         accuracy: p.accuracy ?? null,
         speed: p.speed ?? null,
         altitude: p.altitude ?? null,
         heading: p.heading ?? null,
         timestamp: new Date(p.timestamp),
         serverTime,
         synced: false,
      }));

      LocationLog.insertMany(logDocs, { ordered: false }).catch((err) => {
         console.error(
            `[LocationLog] Batch insert partial failure for assignment ${assignmentId}:`,
            err.message,
         );
      });

      // Record activity for latest batch point
      recordEmployeeActivity(req.user.sub);

      const lastPoint = sorted[sorted.length - 1];
      if (lastPoint) {
         emitLocationUpdate({
            companyId: req.user.companyId,
            employeeId: req.user.sub,
            lat: lastPoint.lat,
            lng: lastPoint.lng,
            accuracy: lastPoint.accuracy,
            speed: lastPoint.speed,
            timestamp: lastPoint.timestamp,
         });
      }

      const minStaySeconds = assignment.routeId?.minStaySeconds ?? 300;
      let totalVisited = 0;

      for (const point of sorted) {
         const { valid } = validateGpsPoint(point);
         if (!valid) continue;

         const events = await processGpsPoint({
            assignment,
            point: { lat: point.lat, lng: point.lng },
            serverTime: new Date(point.timestamp),
            employeeId: req.user.sub,
            companyId: req.user.companyId,
            minStaySeconds,
         });

         totalVisited += events.filter((e) => e.event === 'exit_valid').length;
      }

      return sendSuccess(res, 200, `Batch processed. ${totalVisited} center(s) confirmed visited.`, {
         pointsReceived: points.length,
         centersVisited: totalVisited,
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /locations ───────────────────────────────────────────────────────────

/**
 * Returns the breadcrumb trail for an assignment.
 * @type {import('express').RequestHandler}
 */
export const listLocations = async (req, res, next) => {
   try {
      const { assignmentId, hitsOnly } = req.query;

      if (!assignmentId) {
         return next(new AppError('assignmentId query parameter is required.', 400));
      }

      const assignmentFilter = { _id: assignmentId, companyId: req.user.companyId };
      if (req.user.role === USER_ROLES.EMPLOYEE) {
         assignmentFilter.employeeId = req.user.sub;
      }

      const assignmentExists = await Assignment.exists(assignmentFilter);
      if (!assignmentExists) {
         return next(new AppError('Assignment not found or you do not have access.', 404));
      }

      const filter = { assignmentId };
      if (hitsOnly === 'true') {
         filter.geofenceHit = { $ne: null };
      }

      const { data: locations, pagination } = await paginateQuery(
         LocationLog,
         filter,
         { ...req.query, limit: req.query.limit ?? 100 },
         {
            sort: { timestamp: 1 },
            lean: true,
            select: 'lat lng accuracy speed timestamp serverTime geofenceHit synced',
         },
      );

      return sendSuccess(res, 200, 'Locations retrieved successfully.', { locations, pagination });
   } catch (error) {
      return next(error);
   }
};

// ─── POST /assignments/:id/end ────────────────────────────────────────────────

/**
 * Ends an assignment — marks all pending/in_zone centers as skipped.
 * Week 16: creates MissedCenter alerts for unvisited centers (F068).
 *
 * @type {import('express').RequestHandler}
 */
export const endAssignment = async (req, res, next) => {
   try {
      const { id } = req.params;

      const assignment = await Assignment.findOne({
         _id: id,
         companyId: req.user.companyId,
      }).populate('routeId', 'centers managerId minStaySeconds');

      if (!assignment) {
         return next(new AppError('Assignment not found.', 404));
      }

      if (assignment.status === ASSIGNMENT_STATUS.COMPLETED) {
         return sendSuccess(res, 200, 'Assignment was already completed.', {
            assignment,
            progress: assignment.getProgress(),
         });
      }

      const updateFields = {
         status: ASSIGNMENT_STATUS.COMPLETED,
         completedAt: new Date(),
      };

      // Collect centers that will be skipped
      const toSkip = assignment.visitStatuses.filter(
         (vs) => vs.status === VISIT_STATUS.PENDING || vs.status === VISIT_STATUS.IN_ZONE,
      );

      toSkip.forEach((vs, _) => {
         const idx = assignment.visitStatuses.indexOf(vs);
         updateFields[`visitStatuses.${idx}.status`] = VISIT_STATUS.SKIPPED;
      });

      const updated = await Assignment.findByIdAndUpdate(
         id,
         { $set: updateFields },
         { new: true, runValidators: false },
      );

      // ── Emit visit:updated for each skipped center ────────────────────────
      for (const vs of toSkip) {
         try {
            getIO().to(companyRoom(req.user.companyId)).emit('visit:updated', {
               assignmentId: String(assignment._id),
               centerId: String(vs.centerId),
               status: VISIT_STATUS.SKIPPED,
               timestamp: new Date().toISOString(),
            });
         } catch (_) { }
      }

      // ── Create MissedCenter alerts (F068) ─────────────────────────────────
      if (assignment.routeId?.managerId) {
         const employee = await User.findById(assignment.employeeId).select('name').lean();
         await createMissedCenterAlerts({
            assignment,
            companyId: req.user.companyId,
            managerId: String(assignment.routeId.managerId),
            employeeName: employee?.name ?? 'Unknown',
            centers: assignment.routeId.centers ?? [],
         }).catch((err) => {
            console.error('[endAssignment] MissedCenter alert creation failed:', err.message);
         });
      }

      return sendSuccess(res, 200, 'Assignment ended. Remaining centers marked as skipped.', {
         assignment: updated,
         progress: updated.getProgress(),
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /locations/latest ────────────────────────────────────────────────────

/**
 * Returns the most recent GPS point per employee.
 * @type {import('express').RequestHandler}
 */
export const listLatestLocations = async (req, res, next) => {
   try {
      const companyObjectId = new mongoose.Types.ObjectId(req.user.companyId);

      const locations = await LocationLog.aggregate([
         { $match: { companyId: companyObjectId } },
         { $sort: { serverTime: -1 } },
         {
            $group: {
               _id: '$employeeId',
               lat: { $first: '$lat' },
               lng: { $first: '$lng' },
               accuracy: { $first: '$accuracy' },
               speed: { $first: '$speed' },
               timestamp: { $first: '$timestamp' },
               serverTime: { $first: '$serverTime' },
               assignmentId: { $first: '$assignmentId' },
               employeeId: { $first: '$employeeId' },
            },
         },
         {
            $lookup: {
               from: 'users',
               localField: 'employeeId',
               foreignField: '_id',
               as: 'user',
            },
         },
         {
            $lookup: {
               from: 'assignments',
               localField: 'assignmentId',
               foreignField: '_id',
               as: 'assignment',
            },
         },
         {
            $project: {
               _id: 0,
               employeeId: { $toString: '$employeeId' },
               assignmentId: { $toString: '$assignmentId' },
               lat: 1, lng: 1, accuracy: 1, speed: 1,
               timestamp: 1, serverTime: 1,
               employeeName: { $ifNull: [{ $arrayElemAt: ['$user.name', 0] }, 'Unknown'] },
               isActive: { $ifNull: [{ $arrayElemAt: ['$user.isActive', 0] }, false] },
               assignmentStatus: { $ifNull: [{ $arrayElemAt: ['$assignment.status', 0] }, null] },
            },
         },
      ]);

      return sendSuccess(res, 200, 'Latest locations retrieved.', { locations });
   } catch (error) {
      return next(error);
   }
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Emits 'location:update' to company room. Fire-and-forget.
 */
const emitLocationUpdate = (params) => {
   try {
      const { companyId, ...payload } = params;
      getIO()
         .to(companyRoom(companyId))
         .emit('location:update', {
            ...payload,
            emittedAt: new Date().toISOString(),
         });
   } catch (err) {
      console.error('[Socket] Failed to emit location:update:', err.message);
   }
};
