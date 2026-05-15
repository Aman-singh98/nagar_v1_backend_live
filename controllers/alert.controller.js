/**
 * @file controllers/alert.controller.js
 * @description HTTP handlers for Alert management endpoints.
 *
 * Endpoints:
 * ┌────────────────────────────────────────────┬───────────────────┐
 * │ Route                                      │ Roles             │
 * ├────────────────────────────────────────────┼───────────────────┤
 * │ GET  /alerts                               │ admin, manager    │
 * │ GET  /alerts/count                         │ admin, manager    │
 * │ PATCH /alerts/:id/acknowledge              │ admin, manager    │
 * └────────────────────────────────────────────┴───────────────────┘
 *
 * @module controllers/alert
 */

import Alert from '../models/alert.model.js';
import AppError from '../utils/appError.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { paginateQuery } from '../utils/pagination.js';

// ─── GET /alerts ──────────────────────────────────────────────────────────────

/**
 * Returns a paginated list of alerts for the caller's company.
 *
 * Query params:
 *  - date          {string}  Filter by triggeredAt date (YYYY-MM-DD)
 *  - type          {string}  Filter by alert type
 *  - isAcknowledged {boolean} Filter acknowledged/unread
 *  - employeeId    {string}  Filter by specific employee
 *  - page          {number}  Default: 1
 *  - limit         {number}  Default: 20
 *
 * @type {import('express').RequestHandler}
 */
export const listAlerts = async (req, res, next) => {
   try {
      const { date, type, isAcknowledged, employeeId } = req.query;

      const filter = { companyId: req.user.companyId };

      if (type) filter.type = type;
      if (employeeId) filter.employeeId = employeeId;

      if (isAcknowledged !== undefined) {
         filter.isAcknowledged = isAcknowledged === 'true';
      }

      if (date) {
         const d = new Date(date);
         d.setUTCHours(0, 0, 0, 0);
         const nextDay = new Date(d);
         nextDay.setUTCDate(nextDay.getUTCDate() + 1);
         filter.triggeredAt = { $gte: d, $lt: nextDay };
      }

      const { data: alerts, pagination } = await paginateQuery(
         Alert,
         filter,
         req.query,
         {
            sort: { triggeredAt: -1 },
            lean: true,
            populate: [
               { path: 'employeeId', select: 'name email' },
            ],
         },
      );

      return sendSuccess(res, 200, 'Alerts retrieved successfully.', { alerts, pagination });
   } catch (error) {
      return next(error);
   }
};

// ─── GET /alerts/count ────────────────────────────────────────────────────────

/**
 * Returns the count of unacknowledged alerts.
 * Used by the navbar badge indicator.
 *
 * @type {import('express').RequestHandler}
 */
export const getAlertCount = async (req, res, next) => {
   try {
      const count = await Alert.countDocuments({
         companyId: req.user.companyId,
         isAcknowledged: false,
      });

      return sendSuccess(res, 200, 'Alert count retrieved.', { count });
   } catch (error) {
      return next(error);
   }
};

// ─── PATCH /alerts/:id/acknowledge ───────────────────────────────────────────

/**
 * Marks an alert as acknowledged (read) by the manager.
 *
 * @type {import('express').RequestHandler}
 */
export const acknowledgeAlert = async (req, res, next) => {
   try {
      const { id } = req.params;

      const alert = await Alert.findOneAndUpdate(
         {
            _id: id,
            companyId: req.user.companyId,
            isAcknowledged: false,
         },
         {
            $set: {
               isAcknowledged: true,
               acknowledgedAt: new Date(),
            },
         },
         { new: true },
      );

      if (!alert) {
         return next(new AppError('Alert not found or already acknowledged.', 404));
      }

      return sendSuccess(res, 200, 'Alert acknowledged.', { alert });
   } catch (error) {
      return next(error);
   }
};

// ─── PATCH /alerts/acknowledge-all ───────────────────────────────────────────

/**
 * Marks all unacknowledged alerts for the company as read.
 * Used when manager visits the alerts page (clears badge count).
 *
 * @type {import('express').RequestHandler}
 */
export const acknowledgeAllAlerts = async (req, res, next) => {
   try {
      const result = await Alert.updateMany(
         {
            companyId: req.user.companyId,
            isAcknowledged: false,
         },
         {
            $set: {
               isAcknowledged: true,
               acknowledgedAt: new Date(),
            },
         },
      );

      return sendSuccess(res, 200, `${result.modifiedCount} alert(s) acknowledged.`, {
         modifiedCount: result.modifiedCount,
      });
   } catch (error) {
      return next(error);
   }
};
