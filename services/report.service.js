/**
 * @file services/report.service.js
 * @description Pure data-access service for all report endpoints.
 *
 * SRP: This file ONLY fetches and aggregates data from MongoDB.
 *      No HTTP logic, no PDF generation — those live in their own layers.
 *
 * All functions receive plain arguments (companyId, dates, ids) and
 * return plain JavaScript objects — easy to unit-test without mocking Express.
 *
 * @module services/report
 */

import mongoose from 'mongoose';
import Assignment, { VISIT_STATUS, ASSIGNMENT_STATUS } from '../models/assignment.model.js';
import LocationLog from '../models/locationLog.model.js';
import Alert from '../models/alert.model.js';
import User from '../models/user.model.js';

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Calculates total distance (km) between an ordered array of GPS points
 * using the Haversine formula.
 *
 * @param {{ lat: number, lng: number }[]} points
 * @returns {number} Distance in kilometres, rounded to 2 decimal places.
 */
const calculateTotalDistanceKm = (points) => {
   if (points.length < 2) return 0;

   const toRad = (deg) => (deg * Math.PI) / 180;
   const EARTH_RADIUS_KM = 6371;

   let totalKm = 0;
   for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      const dLat = toRad(curr.lat - prev.lat);
      const dLng = toRad(curr.lng - prev.lng);

      const a =
         Math.sin(dLat / 2) ** 2 +
         Math.cos(toRad(prev.lat)) * Math.cos(toRad(curr.lat)) * Math.sin(dLng / 2) ** 2;

      totalKm += EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
   }

   return Math.round(totalKm * 100) / 100;
};

/**
 * Calculates hours worked between two timestamps.
 * Returns 0 if either timestamp is null.
 *
 * @param {Date|null} startedAt
 * @param {Date|null} completedAt
 * @returns {number} Hours rounded to 2 decimal places.
 */
const calculateHoursWorked = (startedAt, completedAt) => {
   if (!startedAt) return 0;
   const end = completedAt ?? new Date();
   return Math.round(((end - startedAt) / (1000 * 60 * 60)) * 100) / 100;
};

/**
 * Computes visit completion percentage from an array of visitStatuses.
 *
 * @param {{ status: string }[]} visitStatuses
 * @returns {number} Percentage (0–100), rounded to 1 decimal place.
 */
const calculateVisitCompletionPct = (visitStatuses) => {
   const total = visitStatuses.length;
   if (total === 0) return 0;
   const visited = visitStatuses.filter((v) => v.status === VISIT_STATUS.VISITED).length;
   return Math.round((visited / total) * 1000) / 10; // 1 decimal place
};

// ─── F085: Team Comparison KPIs ───────────────────────────────────────────────

/**
 * Fetches all assignments for a company on a given date and aggregates
 * per-employee KPIs for the team comparison report.
 *
 * KPIs per employee:
 *  - visitCompletionPct : % centers visited (not skipped)
 *  - hoursWorked        : duration from startedAt to completedAt/now
 *  - distanceKm         : GPS breadcrumb distance
 *  - alertCount         : alerts triggered on this date
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @param {Date} date  UTC-midnight date
 * @returns {Promise<Array>}
 */
export const buildTeamComparisonKpis = async (companyId, date) => {
   // 1. Fetch all assignments for the day with employee details
   const assignments = await Assignment.find({ companyId, date })
      .populate('employeeId', 'name email')
      .populate('routeId', 'name')
      .lean();

   if (assignments.length === 0) return [];

   // 2. Collect all employeeIds so we can batch-fetch GPS + alerts
   const employeeIds = assignments.map((a) => a.employeeId?._id).filter(Boolean);

   const nextDay = new Date(date);
   nextDay.setUTCDate(nextDay.getUTCDate() + 1);

   // 3. Batch fetch GPS logs for all employees on this date (one query)
   const allLocationLogs = await LocationLog.find({
      companyId,
      timestamp: { $gte: date, $lt: nextDay },
      employeeId: { $in: employeeIds },
   })
      .select('employeeId lat lng timestamp')
      .sort({ employeeId: 1, timestamp: 1 })
      .lean();

   // 4. Batch fetch alert counts per employee (aggregation pipeline)
   const alertCounts = await Alert.aggregate([
      {
         $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            triggeredAt: { $gte: date, $lt: nextDay },
            employeeId: { $in: employeeIds.map((id) => new mongoose.Types.ObjectId(id)) },
         },
      },
      { $group: { _id: '$employeeId', count: { $sum: 1 } } },
   ]);

   // 5. Build lookup maps for O(1) access in the loop below
   const gpsByEmployee = allLocationLogs.reduce((map, log) => {
      const key = log.employeeId.toString();
      if (!map[key]) map[key] = [];
      map[key].push({ lat: log.lat, lng: log.lng });
      return map;
   }, {});

   const alertCountByEmployee = alertCounts.reduce((map, row) => {
      map[row._id.toString()] = row.count;
      return map;
   }, {});

   // 6. Shape the final response — one object per assignment
   return assignments.map((assignment) => {
      const empId = assignment.employeeId?._id?.toString();

      return {
         assignmentId: assignment._id,
         employeeId: empId,
         employeeName: assignment.employeeId?.name ?? 'Unknown',
         employeeEmail: assignment.employeeId?.email ?? '',
         routeName: assignment.routeId?.name ?? 'Unknown Route',
         assignmentStatus: assignment.status,
         visitCompletionPct: calculateVisitCompletionPct(assignment.visitStatuses),
         hoursWorked: calculateHoursWorked(assignment.startedAt, assignment.completedAt),
         distanceKm: calculateTotalDistanceKm(gpsByEmployee[empId] ?? []),
         alertCount: alertCountByEmployee[empId] ?? 0,
      };
   });
};

// ─── F084: Per-Center Visit History ───────────────────────────────────────────

/**
 * Fetches all visits to a specific center (by centerId) across all employees
 * within a date range. Queries the Assignment collection's visitStatuses
 * sub-array, then joins employee names.
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @param {string} centerId  ObjectId string of the center sub-document
 * @param {Date}   startDate UTC-midnight start (inclusive)
 * @param {Date}   endDate   UTC-midnight end (inclusive)
 * @returns {Promise<Array>}
 */
export const fetchCenterVisitHistory = async (companyId, centerId, startDate, endDate) => {
   const inclusiveEndDate = new Date(endDate);
   inclusiveEndDate.setUTCDate(inclusiveEndDate.getUTCDate() + 1);

   // Aggregation pipeline — unwind visitStatuses, match by centerId, join employee
   const results = await Assignment.aggregate([
      {
         $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            date: { $gte: startDate, $lt: inclusiveEndDate },
         },
      },
      // Unwind the embedded visitStatuses array so we can filter per center
      { $unwind: '$visitStatuses' },
      {
         $match: {
            'visitStatuses.centerId': new mongoose.Types.ObjectId(centerId),
            'visitStatuses.status': VISIT_STATUS.VISITED,
         },
      },
      // Join employee details
      {
         $lookup: {
            from: 'users',
            localField: 'employeeId',
            foreignField: '_id',
            as: 'employee',
         },
      },
      { $unwind: { path: '$employee', preserveNullAndEmpty: true } },
      {
         $project: {
            _id: 0,
            employeeId: '$employeeId',
            employeeName: '$employee.name',
            date: '$date',
            visitTime: '$visitStatuses.visitedAt',
            durationSeconds: '$visitStatuses.durationSeconds',
            note: '$visitStatuses.note',
         },
      },
      { $sort: { date: -1, visitTime: -1 } },
   ]);

   return results;
};

// ─── F087: Employee PDF Report Data ───────────────────────────────────────────

/**
 * Collects all data needed to generate a PDF report for one employee.
 * Returns null if the employee does not exist or has no assignments.
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @param {string} employeeId
 * @param {Date}   startDate
 * @param {Date}   endDate
 * @returns {Promise<Object|null>}
 */
export const buildEmployeePdfReportData = async (companyId, employeeId, startDate, endDate) => {
   // 1. Verify employee exists and belongs to this company
   const employee = await User.findOne({
      _id: employeeId,
      companyId,
   }).lean();

   if (!employee) return null;

   const inclusiveEndDate = new Date(endDate);
   inclusiveEndDate.setUTCDate(inclusiveEndDate.getUTCDate() + 1);

   // 2. Fetch all assignments in range with route info
   const assignments = await Assignment.find({
      companyId,
      employeeId,
      date: { $gte: startDate, $lt: inclusiveEndDate },
   })
      .populate('routeId', 'name centers')
      .sort({ date: 1 })
      .lean();

   // 3. Fetch GPS logs for distance calculation
   const locationLogs = await LocationLog.find({
      companyId,
      employeeId,
      timestamp: { $gte: startDate, $lt: inclusiveEndDate },
   })
      .select('lat lng timestamp')
      .sort({ timestamp: 1 })
      .lean();

   // 4. Fetch alerts
   const alerts = await Alert.find({
      companyId,
      employeeId,
      triggeredAt: { $gte: startDate, $lt: inclusiveEndDate },
   })
      .select('type message triggeredAt')
      .lean();

   // 5. Build per-day rows for the PDF table
   const dailyRows = assignments.map((assignment) => {
      const completionPct = calculateVisitCompletionPct(assignment.visitStatuses);
      const hoursWorked = calculateHoursWorked(assignment.startedAt, assignment.completedAt);

      // Filter GPS points to this assignment's date only
      const assignDate = new Date(assignment.date);
      const nextDay = new Date(assignDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);

      const dayPoints = locationLogs.filter(
         (l) => l.timestamp >= assignDate && l.timestamp < nextDay,
      );

      const distanceKm = calculateTotalDistanceKm(dayPoints);
      const visited = assignment.visitStatuses.filter((v) => v.status === VISIT_STATUS.VISITED).length;
      const total = assignment.visitStatuses.length;

      return {
         date: assignDate.toISOString().split('T')[0],
         routeName: assignment.routeId?.name ?? 'Unknown Route',
         status: assignment.status,
         centersVisited: visited,
         centersTotal: total,
         completionPct,
         hoursWorked,
         distanceKm,
         startedAt: assignment.startedAt,
         completedAt: assignment.completedAt,
      };
   });

   // 6. Compute totals
   const totals = {
      totalHours: Math.round(dailyRows.reduce((sum, r) => sum + r.hoursWorked, 0) * 100) / 100,
      totalDistance: Math.round(dailyRows.reduce((sum, r) => sum + r.distanceKm, 0) * 100) / 100,
      totalAlerts: alerts.length,
      totalDays: dailyRows.length,
      avgCompletion:
         dailyRows.length > 0
            ? Math.round(dailyRows.reduce((sum, r) => sum + r.completionPct, 0) / dailyRows.length * 10) / 10
            : 0,
   };

   return {
      employeeId: employee._id.toString(),
      employeeName: employee.name,
      employeeEmail: employee.email,
      companyId: companyId.toString(),
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      dailyRows,
      totals,
      alerts,
   };
};

// ─── Existing: Daily Report ───────────────────────────────────────────────────

/**
 * Builds a per-employee summary for a single day.
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @param {Date} date
 * @returns {Promise<Array>}
 */
export const buildDailyReport = async (companyId, date) => {
   const assignments = await Assignment.find({ companyId, date })
      .populate('employeeId', 'name email')
      .populate('routeId', 'name')
      .lean();

   return assignments.map((a) => ({
      employeeName: a.employeeId?.name ?? 'Unknown',
      employeeEmail: a.employeeId?.email ?? '',
      routeName: a.routeId?.name ?? 'Unknown Route',
      status: a.status,
      visitCompletionPct: calculateVisitCompletionPct(a.visitStatuses),
      centersVisited: a.visitStatuses.filter((v) => v.status === VISIT_STATUS.VISITED).length,
      centersTotal: a.visitStatuses.length,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      hoursWorked: calculateHoursWorked(a.startedAt, a.completedAt),
   }));
};

// ─── Existing: Weekly Report ──────────────────────────────────────────────────

/**
 * Builds a 7-day summary per employee.
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<Array>}
 */
export const buildWeeklyReport = async (companyId, startDate, endDate) => {
   const inclusiveEnd = new Date(endDate);
   inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() + 1);

   const assignments = await Assignment.find({
      companyId,
      date: { $gte: startDate, $lt: inclusiveEnd },
   })
      .populate('employeeId', 'name email')
      .populate('routeId', 'name')
      .sort({ date: 1 })
      .lean();

   // Group by employee
   const byEmployee = {};
   for (const a of assignments) {
      const empId = a.employeeId?._id?.toString();
      if (!byEmployee[empId]) {
         byEmployee[empId] = {
            employeeId: empId,
            employeeName: a.employeeId?.name ?? 'Unknown',
            employeeEmail: a.employeeId?.email ?? '',
            days: [],
         };
      }
      byEmployee[empId].days.push({
         date: a.date.toISOString().split('T')[0],
         routeName: a.routeId?.name ?? 'Unknown',
         status: a.status,
         visitCompletionPct: calculateVisitCompletionPct(a.visitStatuses),
         hoursWorked: calculateHoursWorked(a.startedAt, a.completedAt),
      });
   }

   return Object.values(byEmployee);
};

// ─── Existing: Live Location Map ──────────────────────────────────────────────

/**
 * Fetches the most recent GPS ping per employee for the live map view.
 *
 * @param {string|mongoose.Types.ObjectId} companyId
 * @returns {Promise<Array>}
 */
export const fetchLiveLocationMapData = async (companyId) => {
   const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

   const recentLogs = await LocationLog.aggregate([
      {
         $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            serverTime: { $gte: fiveMinutesAgo },
         },
      },
      { $sort: { serverTime: -1 } },
      {
         $group: {
            _id: '$employeeId',
            lat: { $first: '$lat' },
            lng: { $first: '$lng' },
            serverTime: { $first: '$serverTime' },
         },
      },
      {
         $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'employee',
         },
      },
      { $unwind: { path: '$employee', preserveNullAndEmpty: true } },
      {
         $project: {
            employeeId: '$_id',
            employeeName: '$employee.name',
            lat: 1,
            lng: 1,
            lastSeenAt: '$serverTime',
         },
      },
   ]);

   return recentLogs;
};
