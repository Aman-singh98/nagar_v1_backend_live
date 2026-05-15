/**
 * @file jobs/trackingOffCron.js
 * @description Cron job that detects employees who have stopped sending GPS pings. (F071)
 *
 * Runs every 2 minutes.
 * For each employee with an active assignment:
 *   if (now - lastSeenAt) > TRACKING_OFF_THRESHOLD_MS → fire TrackingOff alert
 *
 * Design decisions:
 *  - Runs as a singleton — initTrackingOffCron() is called once in server.js.
 *  - Uses node-cron for reliable scheduling (not setInterval which drifts).
 *  - Queries only in_progress assignments to avoid false alerts for pending/completed.
 *  - Deduplication in alertService prevents spam — one alert per 10 minutes per employee.
 * 
 * Week 17 additions:
 *  - Idle alert: distance < 100m in last 30 minutes (F070)
 *  - LateStart alert: assignment not started by 10:00 AM (F075)
 *
 * Schedule:
 *  - TrackingOff + Idle: every 2 minutes
 *  - LateStart: daily at 10:00 AM UTC
 *
 * @module jobs/trackingOffCron
 */

import cron from 'node-cron';
import mongoose from 'mongoose';
import Assignment, { ASSIGNMENT_STATUS } from '../models/assignment.model.js';
import LocationLog from '../models/locationLog.model.js';
import { getAllTrackedEmployees, getLastSeenAt } from '../services/employeeActivityTracker.js';
import {
   createTrackingOffAlert,
   createIdleAlert,
   createLateStartAlert,
} from '../services/alertService.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TRACKING_OFF_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes
const IDLE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_DISTANCE_THRESHOLD_M = 100;            // 100 metres
const LATE_START_HOUR_UTC = 10;             // 10:00 AM UTC

// ─── Singleton guard ──────────────────────────────────────────────────────────

let _isInitialised = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

export const initTrackingOffCron = () => {
   if (_isInitialised) {
      console.warn('[TrackingOffCron] Already initialised — skipping.');
      return;
   }

   // TrackingOff + Idle — every 2 minutes
   cron.schedule('*/2 * * * *', runTrackingOffAndIdleCheck, {
      scheduled: true,
      timezone: 'UTC',
   });

   // LateStart — daily at 10:00 AM UTC
   cron.schedule(`0 ${LATE_START_HOUR_UTC} * * *`, runLateStartCheck, {
      scheduled: true,
      timezone: 'UTC',
   });

   _isInitialised = true;
   console.log('✅  TrackingOff + Idle + LateStart cron jobs initialised');
};

// ─── TrackingOff + Idle Check ─────────────────────────────────────────────────

const runTrackingOffAndIdleCheck = async () => {
   try {
      const now = new Date();

      const activeAssignments = await Assignment
         .find({ status: ASSIGNMENT_STATUS.IN_PROGRESS })
         .populate('employeeId', 'name companyId')
         .populate('routeId', 'managerId')
         .lean();

      if (activeAssignments.length === 0) return;

      for (const assignment of activeAssignments) {
         const employee = assignment.employeeId;
         if (!employee) continue;

         const employeeId = String(employee._id);
         const managerId = assignment.routeId?.managerId;
         if (!managerId) continue;

         const lastSeenAt = getLastSeenAt(employeeId);
         const baselineTime = lastSeenAt ?? assignment.startedAt ?? now;
         const silenceDuration = now - baselineTime;

         // ── TrackingOff check ────────────────────────────────────────────────
         if (silenceDuration >= TRACKING_OFF_THRESHOLD_MS) {
            await createTrackingOffAlert({
               employeeId,
               employeeName: employee.name ?? 'Unknown',
               assignmentId: String(assignment._id),
               companyId: String(employee.companyId),
               managerId: String(managerId),
               lastSeenAt: baselineTime,
            });
         }

         // ── Idle check ───────────────────────────────────────────────────────
         await checkIdleAlert({
            employeeId,
            employeeName: employee.name ?? 'Unknown',
            assignmentId: String(assignment._id),
            companyId: String(employee.companyId),
            managerId: String(managerId),
            now,
         });
      }
   } catch (err) {
      console.error('[TrackingOffCron] Error:', err.message);
   }
};

// ─── Idle Alert Logic ─────────────────────────────────────────────────────────

/**
 * Checks if an employee has moved less than IDLE_DISTANCE_THRESHOLD_M
 * in the last IDLE_WINDOW_MS milliseconds.
 */
const checkIdleAlert = async ({
   employeeId, employeeName, assignmentId,
   companyId, managerId, now,
}) => {
   try {
      const windowStart = new Date(now - IDLE_WINDOW_MS);

      const recentPoints = await LocationLog
         .find({
            employeeId: new mongoose.Types.ObjectId(employeeId),
            assignmentId: new mongoose.Types.ObjectId(assignmentId),
            serverTime: { $gte: windowStart },
         })
         .select('lat lng')
         .lean();

      if (recentPoints.length < 2) return;

      // Calculate total distance using haversine
      let totalDistance = 0;
      for (let i = 1; i < recentPoints.length; i++) {
         totalDistance += haversineDistance(
            recentPoints[i - 1].lat, recentPoints[i - 1].lng,
            recentPoints[i].lat, recentPoints[i].lng,
         );
      }

      if (totalDistance < IDLE_DISTANCE_THRESHOLD_M) {
         await createIdleAlert({
            employeeId,
            employeeName,
            assignmentId,
            companyId,
            managerId,
            distanceMeters: totalDistance,
            windowMinutes: Math.round(IDLE_WINDOW_MS / 60_000),
         });
      }
   } catch (err) {
      console.error(`[IdleCheck] Error for employee=${employeeId}:`, err.message);
   }
};

// ─── LateStart Check ──────────────────────────────────────────────────────────

const runLateStartCheck = async () => {
   try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      // Find all pending assignments for today
      const pendingAssignments = await Assignment
         .find({
            date: today,
            status: ASSIGNMENT_STATUS.PENDING,
            startedAt: null,
         })
         .populate('employeeId', 'name companyId')
         .populate('routeId', 'managerId')
         .lean();

      for (const assignment of pendingAssignments) {
         const employee = assignment.employeeId;
         const managerId = assignment.routeId?.managerId;
         if (!employee || !managerId) continue;

         await createLateStartAlert({
            employeeId: String(employee._id),
            employeeName: employee.name ?? 'Unknown',
            assignmentId: String(assignment._id),
            companyId: String(employee.companyId),
            managerId: String(managerId),
         });
      }

      if (pendingAssignments.length > 0) {
         console.log(`[LateStartCron] ${pendingAssignments.length} LateStart alert(s) created`);
      }
   } catch (err) {
      console.error('[LateStartCron] Error:', err.message);
   }
};

// ─── Haversine (local copy to avoid circular import) ─────────────────────────

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_000;

const haversineDistance = (lat1, lng1, lat2, lng2) => {
   const φ1 = lat1 * DEG_TO_RAD;
   const φ2 = lat2 * DEG_TO_RAD;
   const Δφ = (lat2 - lat1) * DEG_TO_RAD;
   const Δλ = (lng2 - lng1) * DEG_TO_RAD;
   const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
   return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};