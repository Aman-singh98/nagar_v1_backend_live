/**
 * @file controllers/report.controller.js
 * @description HTTP handlers for advanced reporting endpoints.
 *
 * Endpoints:
 * ┌──────────────────────────────────────────────┬───────────────────┐
 * │ Route                                        │ Roles             │
 * ├──────────────────────────────────────────────┼───────────────────┤
 * │ GET /locations/map                           │ admin, manager    │
 * │ GET /reports/daily                           │ admin, manager    │
 * │ GET /reports/weekly                          │ admin, manager    │
 * │ GET /reports/employee-history                │ all authed        │
 * └──────────────────────────────────────────────┴───────────────────┘
 *
 * @module controllers/report
 */

import mongoose from 'mongoose';
import LocationLog from '../models/locationLog.model.js';
import Assignment, { ASSIGNMENT_STATUS } from '../models/assignment.model.js';
import AppError from '../utils/appError.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { haversineDistance } from '../services/geofence.service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Pre-computed distance cache TTL — not needed since we store on assignment */
const DEG_TO_RAD = Math.PI / 180;

// ─── GET /locations/map ───────────────────────────────────────────────────────

/**
 * Returns all GPS points for an employee on a given date in chronological order.
 * Used by the History map page to render the polyline path. (F079)
 *
 * Query params:
 *  - employeeId {string} required
 *  - date       {string} required — YYYY-MM-DD
 *
 * @type {import('express').RequestHandler}
 */
export const getLocationMapData = async (req, res, next) => {
   try {
      const { employeeId, date } = req.query;

      if (!employeeId || !date) {
         return next(new AppError('employeeId and date are required query parameters.', 400));
      }

      // Build date range for the day
      const dayStart = new Date(date);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setUTCHours(23, 59, 59, 999);

      // Find assignment for that day
      const assignment = await Assignment.findOne({
         employeeId: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: { $gte: dayStart, $lte: dayEnd },
      })
         .populate('routeId', 'name centers')
         .lean();

      // Fetch all GPS points for the day
      const points = await LocationLog.find({
         employeeId: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         timestamp: { $gte: dayStart, $lte: dayEnd },
      })
         .sort({ timestamp: 1 })
         .select('lat lng accuracy speed timestamp serverTime')
         .lean();

      if (points.length === 0) {
         return sendSuccess(res, 200, 'No location data found for this date.', {
            points: [],
            assignment: null,
            summary: { totalPoints: 0, distanceMeters: 0, durationMinutes: 0 },
         });
      }

      // Calculate total distance
      const distanceMeters = calculateTotalDistance(points);

      // Calculate duration
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      const durationMinutes = Math.round(
         (new Date(lastPoint.timestamp) - new Date(firstPoint.timestamp)) / 60_000,
      );

      return sendSuccess(res, 200, 'Location map data retrieved.', {
         points: points.map((p) => ({
            lat: p.lat,
            lng: p.lng,
            accuracy: p.accuracy,
            speed: p.speed,
            timestamp: p.timestamp,
         })),
         assignment: assignment ? {
            id: String(assignment._id),
            status: assignment.status,
            startedAt: assignment.startedAt,
            completedAt: assignment.completedAt,
            routeName: assignment.routeId?.name ?? null,
            centers: assignment.routeId?.centers?.map((c) => ({
               id: String(c._id),
               name: c.name,
               lat: c.lat,
               lng: c.lng,
               order: c.order,
               radius: c.radius,
            })) ?? [],
            visitStatuses: assignment.visitStatuses ?? [],
         } : null,
         summary: {
            totalPoints: points.length,
            distanceMeters: Math.round(distanceMeters),
            durationMinutes,
            startTime: firstPoint.timestamp,
            endTime: lastPoint.timestamp,
         },
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /reports/daily ───────────────────────────────────────────────────────

/**
 * Returns a daily report for one or all employees.
 * Includes distanceMeters and hoursWorked per assignment. (F081, F082)
 *
 * Query params:
 *  - date        {string}  required — YYYY-MM-DD
 *  - employeeId  {string}  optional — filter to one employee
 *  - startDate   {string}  optional — date range start (F088)
 *  - endDate     {string}  optional — date range end (F088)
 *
 * @type {import('express').RequestHandler}
 */
export const getDailyReport = async (req, res, next) => {
   try {
      const { date, employeeId, startDate, endDate } = req.query;

      // Build date filter — single date OR date range (F088)
      let dateFilter = {};
      if (startDate && endDate) {
         const start = new Date(startDate);
         start.setUTCHours(0, 0, 0, 0);
         const end = new Date(endDate);
         end.setUTCHours(23, 59, 59, 999);
         dateFilter = { $gte: start, $lte: end };
      } else if (date) {
         const d = new Date(date);
         d.setUTCHours(0, 0, 0, 0);
         const nextDay = new Date(d);
         nextDay.setUTCDate(nextDay.getUTCDate() + 1);
         dateFilter = { $gte: d, $lt: nextDay };
      } else {
         return next(new AppError('date or startDate+endDate is required.', 400));
      }

      const filter = {
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: dateFilter,
      };

      if (employeeId) {
         filter.employeeId = new mongoose.Types.ObjectId(employeeId);
      }

      const assignments = await Assignment.find(filter)
         .populate('employeeId', 'name email')
         .populate('routeId', 'name centers')
         .lean();

      // Enrich each assignment with distance + hours
      const enriched = await Promise.all(
         assignments.map(async (asgn) => {
            const { distanceMeters, hoursWorked } = await computeAssignmentMetrics(asgn);

            const visited = asgn.visitStatuses.filter((v) => v.status === 'visited').length;
            const total = asgn.visitStatuses.length;
            const skipped = asgn.visitStatuses.filter((v) => v.status === 'skipped').length;

            return {
               assignmentId: String(asgn._id),
               employeeId: String(asgn.employeeId?._id ?? asgn.employeeId),
               employeeName: asgn.employeeId?.name ?? 'Unknown',
               employeeEmail: asgn.employeeId?.email ?? '',
               routeName: asgn.routeId?.name ?? 'Unknown',
               date: asgn.date,
               status: asgn.status,
               startedAt: asgn.startedAt,
               completedAt: asgn.completedAt,
               centersTotal: total,
               centersVisited: visited,
               centersSkipped: skipped,
               completionPct: total > 0 ? Math.round((visited / total) * 100) : 0,
               distanceMeters,
               hoursWorked,
            };
         }),
      );

      return sendSuccess(res, 200, 'Daily report retrieved.', {
         report: enriched,
         totals: {
            assignments: enriched.length,
            completed: enriched.filter((r) => r.status === ASSIGNMENT_STATUS.COMPLETED).length,
            totalDistanceM: enriched.reduce((s, r) => s + r.distanceMeters, 0),
            avgHoursWorked: enriched.length > 0
               ? Math.round((enriched.reduce((s, r) => s + r.hoursWorked, 0) / enriched.length) * 10) / 10
               : 0,
         },
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /reports/weekly ──────────────────────────────────────────────────────

/**
 * Returns a weekly summary for one employee.
 * Aggregates distanceMeters and hoursWorked across the week. (F081, F082)
 *
 * Query params:
 *  - employeeId  {string} required
 *  - weekStart   {string} required — YYYY-MM-DD (Monday)
 *
 * @type {import('express').RequestHandler}
 */
export const getWeeklyReport = async (req, res, next) => {
   try {
      const { employeeId, weekStart } = req.query;

      if (!employeeId || !weekStart) {
         return next(new AppError('employeeId and weekStart are required.', 400));
      }

      const start = new Date(weekStart);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      end.setUTCHours(23, 59, 59, 999);

      const assignments = await Assignment.find({
         employeeId: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: { $gte: start, $lte: end },
      })
         .populate('routeId', 'name')
         .lean();

      const dailyBreakdown = await Promise.all(
         assignments.map(async (asgn) => {
            const { distanceMeters, hoursWorked } = await computeAssignmentMetrics(asgn);
            const visited = asgn.visitStatuses.filter((v) => v.status === 'visited').length;
            const total = asgn.visitStatuses.length;

            return {
               date: asgn.date,
               assignmentId: String(asgn._id),
               routeName: asgn.routeId?.name ?? 'Unknown',
               status: asgn.status,
               centersVisited: visited,
               centersTotal: total,
               distanceMeters,
               hoursWorked,
            };
         }),
      );

      const totals = {
         daysWorked: dailyBreakdown.filter((d) => d.status === ASSIGNMENT_STATUS.COMPLETED).length,
         totalDistanceM: dailyBreakdown.reduce((s, d) => s + d.distanceMeters, 0),
         totalHoursWorked: Math.round(dailyBreakdown.reduce((s, d) => s + d.hoursWorked, 0) * 10) / 10,
         totalCentersVisited: dailyBreakdown.reduce((s, d) => s + d.centersVisited, 0),
         totalCentersTotal: dailyBreakdown.reduce((s, d) => s + d.centersTotal, 0),
      };

      return sendSuccess(res, 200, 'Weekly report retrieved.', {
         employeeId,
         weekStart: start,
         weekEnd: end,
         dailyBreakdown,
         totals,
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /reports/employee-history ───────────────────────────────────────────

/**
 * Returns the last N days of assignment history for one employee.
 * Each assignment becomes one "session" matching the shape expected by
 * the mobile app's useHistoryData hook.
 *
 * Query params:
 *  - employeeId  {string}  required — the employee whose history to fetch
 *  - lastDays    {number}  optional — how many days back to look (default: 30)
 *
 * Response shape (each session):
 * {
 *   _id, date, hoursWorked, distanceKm, totalDistanceKm,
 *   centersVisited, centersTotal,
 *   centers: [{ _id, name, address, visitStatus, visitedAt }]
 * }
 *
 * @type {import('express').RequestHandler}
 */
export const getEmployeeHistory = async (req, res, next) => {
   try {
      const { employeeId, lastDays = 30 } = req.query;

      if (!employeeId) {
         return next(new AppError('employeeId is required.', 400));
      }

      // ── Date range ────────────────────────────────────────────────────────────
      const end = new Date();
      end.setUTCHours(23, 59, 59, 999);

      const start = new Date();
      start.setUTCDate(start.getUTCDate() - Number(lastDays));
      start.setUTCHours(0, 0, 0, 0);

      // ── Fetch assignments in range ────────────────────────────────────────────
      const assignments = await Assignment.find({
         employeeId: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: { $gte: start, $lte: end },
      })
         .populate('routeId', 'name centers')
         .sort({ date: -1 })
         .lean();

      if (assignments.length === 0) {
         return sendSuccess(res, 200, 'No history found.', { sessions: [] });
      }

      // ── Build one session per assignment ──────────────────────────────────────
      const sessions = await Promise.all(
         assignments.map(async (asgn) => {
            // Compute distance + hours from GPS logs
            const { distanceMeters, hoursWorked } = await computeAssignmentMetrics(asgn);

            // Build center list by merging route center metadata with visit statuses
            const routeCenters = asgn.routeId?.centers ?? [];
            const centers = routeCenters.map((center) => {
               const vs = asgn.visitStatuses.find(
                  (v) => String(v.centerId) === String(center._id),
               );
               return {
                  _id: center._id,
                  name: center.name,
                  address: center.address ?? '',
                  visitStatus: vs?.status ?? 'pending',
                  visitedAt: vs?.visitedAt ?? null,
               };
            });

            const centersVisited = asgn.visitStatuses.filter(
               (v) => v.status === 'visited',
            ).length;
            const centersTotal = asgn.visitStatuses.length;

            return {
               _id: asgn._id,
               date: asgn.date,
               hoursWorked,
               distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
               totalDistanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
               centersVisited,
               centersTotal,
               status: asgn.status,
               startedAt: asgn.startedAt,
               completedAt: asgn.completedAt,
               routeName: asgn.routeId?.name ?? 'Unknown',
               centers,
            };
         }),
      );

      return sendSuccess(res, 200, 'Employee history retrieved.', { sessions });
   } catch (error) {
      return next(error);
   }
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Calculates total distance traveled for an assignment by summing
 * Haversine distances between consecutive GPS points.
 * Uses cached distanceMeters on the assignment if available.
 *
 * @param {object} assignment - Lean assignment document
 * @returns {Promise<{ distanceMeters: number, hoursWorked: number }>}
 */
const computeAssignmentMetrics = async (assignment) => {
   // Use cached value if available (set when assignment ends)
   if (assignment.distanceMeters != null) {
      const hoursWorked = computeHoursWorked(assignment);
      return { distanceMeters: assignment.distanceMeters, hoursWorked };
   }

   // Compute from GPS points
   const dayStart = new Date(assignment.date);
   dayStart.setUTCHours(0, 0, 0, 0);
   const dayEnd = new Date(assignment.date);
   dayEnd.setUTCHours(23, 59, 59, 999);

   const points = await LocationLog.find({
      assignmentId: assignment._id,
      timestamp: { $gte: dayStart, $lte: dayEnd },
   })
      .sort({ timestamp: 1 })
      .select('lat lng')
      .lean();

   const distanceMeters = Math.round(calculateTotalDistance(points));
   const hoursWorked = computeHoursWorked(assignment);

   return { distanceMeters, hoursWorked };
};

/**
 * Calculates hours worked from assignment startedAt → completedAt.
 *
 * @param {object} assignment
 * @returns {number} Hours worked (rounded to 2dp)
 */
const computeHoursWorked = (assignment) => {
   if (!assignment.startedAt) return 0;
   const end = assignment.completedAt ?? new Date();
   return Math.round(((end - new Date(assignment.startedAt)) / 3_600_000) * 100) / 100;
};

/**
 * Sums Haversine distances between consecutive GPS points.
 *
 * @param {Array<{ lat: number, lng: number }>} points
 * @returns {number} Total distance in metres
 */
const calculateTotalDistance = (points) => {
   let total = 0;
   for (let i = 1; i < points.length; i++) {
      total += haversineDistance(
         points[i - 1].lat, points[i - 1].lng,
         points[i].lat, points[i].lng,
      );
   }
   return total;
};
