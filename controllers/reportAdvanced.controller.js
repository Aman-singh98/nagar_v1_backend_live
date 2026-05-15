/**
 * @file controllers/reportAdvanced.controller.js
 * @description Advanced report endpoints — team comparison, center history, PDF export.
 *
 * Week 19 additions:
 *  - F085: Team comparison report
 *  - F084: Per-center visit history
 *  - F087: PDF export
 *
 * @module controllers/reportAdvanced
 */

import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import Assignment, { ASSIGNMENT_STATUS, VISIT_STATUS } from '../models/assignment.model.js';
import LocationLog from '../models/locationLog.model.js';
import Alert from '../models/alert.model.js';
import Route from '../models/route.model.js';
import User from '../models/user.model.js';
import AppError from '../utils/appError.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { haversineDistance } from '../services/geofence.service.js';

// ─── GET /reports/team ────────────────────────────────────────────────────────

/**
 * Returns all employees with their daily KPIs side by side. (F085)
 *
 * Query params:
 *  - date       {string} required — YYYY-MM-DD
 *  - startDate  {string} optional — date range start
 *  - endDate    {string} optional — date range end
 *
 * @type {import('express').RequestHandler}
 */
export const getTeamReport = async (req, res, next) => {
   try {
      const { date, startDate, endDate } = req.query;

      // Build date filter
      let dateFilter = {};
      if (startDate && endDate) {
         const start = new Date(startDate); start.setUTCHours(0, 0, 0, 0);
         const end = new Date(endDate); end.setUTCHours(23, 59, 59, 999);
         dateFilter = { $gte: start, $lte: end };
      } else if (date) {
         const d = new Date(date); d.setUTCHours(0, 0, 0, 0);
         const nextDay = new Date(d); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
         dateFilter = { $gte: d, $lt: nextDay };
      } else {
         return next(new AppError('date or startDate+endDate is required.', 400));
      }

      const assignments = await Assignment.find({
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: dateFilter,
      })
         .populate('employeeId', 'name email')
         .lean();

      // Group by employee
      const employeeMap = new Map();

      for (const asgn of assignments) {
         const empId = String(asgn.employeeId?._id ?? asgn.employeeId);
         const empName = asgn.employeeId?.name ?? 'Unknown';

         if (!employeeMap.has(empId)) {
            employeeMap.set(empId, {
               employeeId: empId,
               employeeName: empName,
               employeeEmail: asgn.employeeId?.email ?? '',
               assignments: [],
            });
         }
         employeeMap.get(empId).assignments.push(asgn);
      }

      // Enrich each employee
      const team = await Promise.all(
         Array.from(employeeMap.values()).map(async ({ employeeId, employeeName, employeeEmail, assignments: asgnList }) => {
            let totalDistance = 0;
            let totalHours = 0;
            let totalVisited = 0;
            let totalCenters = 0;
            let completedCount = 0;

            for (const asgn of asgnList) {
               const { distanceMeters, hoursWorked } = await computeMetrics(asgn);
               totalDistance += distanceMeters;
               totalHours += hoursWorked;
               totalVisited += asgn.visitStatuses.filter((v) => v.status === VISIT_STATUS.VISITED).length;
               totalCenters += asgn.visitStatuses.length;
               if (asgn.status === ASSIGNMENT_STATUS.COMPLETED) completedCount++;
            }

            const visitCompletionPct = totalCenters > 0
               ? Math.round((totalVisited / totalCenters) * 100) : 0;

            // Alert count for this employee in the date range
            const alertCount = await Alert.countDocuments({
               employeeId: new mongoose.Types.ObjectId(employeeId),
               companyId: new mongoose.Types.ObjectId(req.user.companyId),
               triggeredAt: dateFilter,
            });

            return {
               employeeId,
               employeeName,
               employeeEmail,
               assignmentCount: asgnList.length,
               completedCount,
               visitCompletionPct,
               centersVisited: totalVisited,
               centersTotal: totalCenters,
               distanceKm: Math.round((totalDistance / 1000) * 10) / 10,
               hoursWorked: Math.round(totalHours * 10) / 10,
               alertCount,
            };
         }),
      );

      // Sort by visitCompletionPct descending
      team.sort((a, b) => b.visitCompletionPct - a.visitCompletionPct);

      return sendSuccess(res, 200, 'Team report retrieved.', { team });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /centers/:id/visits ──────────────────────────────────────────────────

/**
 * Returns all visits to a specific center across all employees. (F084)
 *
 * Query params:
 *  - startDate {string} required
 *  - endDate   {string} required
 *
 * @type {import('express').RequestHandler}
 */
export const getCenterVisitHistory = async (req, res, next) => {
   try {
      const { id: centerId } = req.params;
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
         return next(new AppError('startDate and endDate are required.', 400));
      }

      const start = new Date(startDate); start.setUTCHours(0, 0, 0, 0);
      const end = new Date(endDate); end.setUTCHours(23, 59, 59, 999);

      // Find all assignments in range that have this center visited
      const assignments = await Assignment.find({
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: { $gte: start, $lte: end },
         'visitStatuses.centerId': new mongoose.Types.ObjectId(centerId),
         'visitStatuses.status': VISIT_STATUS.VISITED,
      })
         .populate('employeeId', 'name email')
         .lean();

      const visits = assignments.map((asgn) => {
         const vs = asgn.visitStatuses.find(
            (v) => String(v.centerId) === centerId && v.status === VISIT_STATUS.VISITED,
         );
         return {
            assignmentId: String(asgn._id),
            employeeId: String(asgn.employeeId?._id ?? asgn.employeeId),
            employeeName: asgn.employeeId?.name ?? 'Unknown',
            date: asgn.date,
            visitedAt: vs?.visitedAt ?? null,
            durationSeconds: vs?.durationSeconds ?? null,
            outOfSequence: vs?.outOfSequence ?? false,
         };
      }).sort((a, b) => new Date(b.date) - new Date(a.date));

      return sendSuccess(res, 200, 'Center visit history retrieved.', {
         centerId,
         totalVisits: visits.length,
         visits,
      });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /reports/pdf ─────────────────────────────────────────────────────────

/**
 * Generates and streams a PDF report for an employee. (F087)
 *
 * Query params:
 *  - employeeId {string} required
 *  - startDate  {string} required
 *  - endDate    {string} required
 *
 * @type {import('express').RequestHandler}
 */
export const generatePdfReport = async (req, res, next) => {
   try {
      const { employeeId, startDate, endDate } = req.query;

      if (!employeeId || !startDate || !endDate) {
         return next(new AppError('employeeId, startDate, and endDate are required.', 400));
      }

      const start = new Date(startDate); start.setUTCHours(0, 0, 0, 0);
      const end = new Date(endDate); end.setUTCHours(23, 59, 59, 999);

      // Fetch employee
      const employee = await User.findOne({
         _id: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
      }).lean();

      if (!employee) {
         return next(new AppError('Employee not found.', 404));
      }

      // Fetch assignments
      const assignments = await Assignment.find({
         employeeId: new mongoose.Types.ObjectId(employeeId),
         companyId: new mongoose.Types.ObjectId(req.user.companyId),
         date: { $gte: start, $lte: end },
      })
         .populate('routeId', 'name')
         .lean();

      // Compute metrics
      const rows = await Promise.all(
         assignments.map(async (asgn) => {
            const { distanceMeters, hoursWorked } = await computeMetrics(asgn);
            const visited = asgn.visitStatuses.filter((v) => v.status === VISIT_STATUS.VISITED).length;
            const total = asgn.visitStatuses.length;
            return {
               date: asgn.date,
               route: asgn.routeId?.name ?? 'Unknown',
               status: asgn.status,
               visited,
               total,
               pct: total > 0 ? Math.round((visited / total) * 100) : 0,
               distance: Math.round(distanceMeters / 100) / 10, // km
               hours: hoursWorked,
            };
         }),
      );
      rows.sort((a, b) => new Date(a.date) - new Date(b.date));

      const totals = {
         distanceKm: Math.round(rows.reduce((s, r) => s + r.distance, 0) * 10) / 10,
         hoursWorked: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 10) / 10,
         visited: rows.reduce((s, r) => s + r.visited, 0),
         total: rows.reduce((s, r) => s + r.total, 0),
         completed: rows.filter((r) => r.status === 'completed').length,
      };

      // ── Generate PDF ──────────────────────────────────────────────────────────
      const doc = new PDFDocument({ margin: 50, size: 'A4' });

      // Stream response
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
         'Content-Disposition',
         `attachment; filename="report-${employee.name.replace(/\s+/g, '-')}-${startDate}-${endDate}.pdf"`,
      );
      doc.pipe(res);

      // ── Header ────────────────────────────────────────────────────────────────
      doc
         .fontSize(22).font('Helvetica-Bold')
         .fillColor('#6366f1')
         .text('Nagar', 50, 50);

      doc
         .fontSize(11).font('Helvetica')
         .fillColor('#6b7280')
         .text('Field Operations Report', 50, 78);

      doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e5e7eb').lineWidth(1).stroke();

      // ── Employee Info ─────────────────────────────────────────────────────────
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827')
         .text('Employee Details', 50, 115);

      const infoY = 135;
      const col1 = 50, col2 = 300;

      doc.fontSize(10).font('Helvetica').fillColor('#6b7280');
      doc.text('Name:', col1, infoY);
      doc.text('Email:', col1, infoY + 18);
      doc.text('Period:', col2, infoY);
      doc.text('Generated:', col2, infoY + 18);

      doc.font('Helvetica-Bold').fillColor('#111827');
      doc.text(employee.name, col1 + 60, infoY);
      doc.text(employee.email, col1 + 60, infoY + 18);
      doc.text(`${startDate} → ${endDate}`, col2 + 70, infoY);
      doc.text(new Date().toLocaleDateString('en-IN'), col2 + 70, infoY + 18);

      // ── Summary Cards ─────────────────────────────────────────────────────────
      doc.moveTo(50, 185).lineTo(545, 185).strokeColor('#e5e7eb').lineWidth(1).stroke();
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827')
         .text('Summary', 50, 195);

      const cards = [
         { label: 'Assignments', value: rows.length },
         { label: 'Completed', value: totals.completed },
         { label: 'Centers Visited', value: `${totals.visited}/${totals.total}` },
         { label: 'Distance', value: `${totals.distanceKm} km` },
         { label: 'Hours Worked', value: `${totals.hoursWorked}h` },
      ];

      const cardW = 98, cardH = 52, cardY = 215;
      cards.forEach((card, i) => {
         const x = 50 + i * (cardW + 2);
         doc.roundedRect(x, cardY, cardW, cardH, 4)
            .fillAndStroke('#f9fafb', '#e5e7eb');

         doc.fontSize(8).font('Helvetica').fillColor('#6b7280')
            .text(card.label, x + 8, cardY + 8, { width: cardW - 16, align: 'center' });

         doc.fontSize(16).font('Helvetica-Bold').fillColor('#6366f1')
            .text(String(card.value), x + 8, cardY + 22, { width: cardW - 16, align: 'center' });
      });

      // ── Daily Table ───────────────────────────────────────────────────────────
      doc.moveTo(50, 285).lineTo(545, 285).strokeColor('#e5e7eb').lineWidth(1).stroke();
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827')
         .text('Daily Breakdown', 50, 295);

      // Table header
      const tableTop = 318;
      const cols = [
         { label: 'Date', x: 50, w: 75 },
         { label: 'Route', x: 130, w: 140 },
         { label: 'Status', x: 275, w: 70 },
         { label: 'Centers', x: 348, w: 60 },
         { label: 'Distance', x: 412, w: 60 },
         { label: 'Hours', x: 475, w: 50 },
      ];

      // Header row
      doc.rect(50, tableTop, 495, 18).fill('#6366f1');
      cols.forEach(({ label, x }) => {
         doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff')
            .text(label, x + 4, tableTop + 5, { width: 80 });
      });

      // Data rows
      let rowY = tableTop + 18;
      rows.forEach((row, idx) => {
         const bg = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
         doc.rect(50, rowY, 495, 18).fill(bg);

         const statusColor = row.status === 'completed' ? '#10b981'
            : row.status === 'in_progress' ? '#f59e0b' : '#6b7280';

         doc.fontSize(8).font('Helvetica').fillColor('#374151');
         doc.text(new Date(row.date).toLocaleDateString('en-IN'), cols[0].x + 4, rowY + 5, { width: cols[0].w });
         doc.text(row.route, cols[1].x + 4, rowY + 5, { width: cols[1].w, ellipsis: true });

         doc.fillColor(statusColor);
         doc.text(row.status.replace('_', ' '), cols[2].x + 4, rowY + 5, { width: cols[2].w });

         doc.fillColor('#374151');
         doc.text(`${row.visited}/${row.total} (${row.pct}%)`, cols[3].x + 4, rowY + 5, { width: cols[3].w });
         doc.text(`${row.distance} km`, cols[4].x + 4, rowY + 5, { width: cols[4].w });
         doc.text(`${row.hours}h`, cols[5].x + 4, rowY + 5, { width: cols[5].w });

         rowY += 18;

         // New page if needed
         if (rowY > 750) {
            doc.addPage();
            rowY = 50;
         }
      });

      // ── Footer ────────────────────────────────────────────────────────────────
      doc.moveTo(50, rowY + 20).lineTo(545, rowY + 20).strokeColor('#e5e7eb').lineWidth(1).stroke();
      doc.fontSize(8).font('Helvetica').fillColor('#9ca3af')
         .text(
            `Generated by Nagar · ${new Date().toLocaleString('en-IN')} · Confidential`,
            50, rowY + 30, { align: 'center', width: 495 },
         );

      doc.end();
   } catch (error) {
      return next(error);
   }
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

const computeMetrics = async (assignment) => {
   if (assignment.distanceMeters != null) {
      return {
         distanceMeters: assignment.distanceMeters,
         hoursWorked: computeHours(assignment),
      };
   }

   const dayStart = new Date(assignment.date); dayStart.setUTCHours(0, 0, 0, 0);
   const dayEnd = new Date(assignment.date); dayEnd.setUTCHours(23, 59, 59, 999);

   const points = await LocationLog.find({
      assignmentId: assignment._id,
      timestamp: { $gte: dayStart, $lte: dayEnd },
   }).sort({ timestamp: 1 }).select('lat lng').lean();

   let dist = 0;
   for (let i = 1; i < points.length; i++) {
      dist += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
   }

   return { distanceMeters: Math.round(dist), hoursWorked: computeHours(assignment) };
};

const computeHours = (asgn) => {
   if (!asgn.startedAt) return 0;
   const end = asgn.completedAt ?? new Date();
   return Math.round(((end - new Date(asgn.startedAt)) / 3_600_000) * 100) / 100;
};
