/**
 * @file services/alertService.js
 * @description Alert creation and socket broadcast service.
 *
 * Single Responsibility: creates alert DB records and emits
 * 'alert:new' socket events to the manager dashboard.
 *
 * Used by:
 *  - trackingOffCron.js  (TrackingOff alerts)
 *  - location.controller.js (MissedCenter alerts on duty end)
 *
 * @module services/alertService
 */
import Alert, { ALERT_TYPES } from '../models/alert.model.js';
import { getIO } from '../socket/socketManager.js';
import { companyRoom } from '../socket/socketHandlers.js';
import { sendAlertPushNotification } from './pushNotificationService.js';

// ─── Deduplication guard ──────────────────────────────────────────────────────

/** @type {Map<string, Date>} */
const _recentAlerts = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

const isDuplicate = (key) => {
   const lastFired = _recentAlerts.get(key);
   if (!lastFired) return false;
   return Date.now() - lastFired.getTime() < DEDUP_WINDOW_MS;
};

const markFired = (key) => {
   _recentAlerts.set(key, new Date());
   setTimeout(() => _recentAlerts.delete(key), DEDUP_WINDOW_MS);
};

// ─── Alert Creators ───────────────────────────────────────────────────────────

/**
 * Creates a TrackingOff alert + sends push notification. (F071)
 */
export const createTrackingOffAlert = async ({
   employeeId,
   employeeName,
   assignmentId,
   companyId,
   managerId,
   lastSeenAt,
}) => {
   const dedupKey = `${ALERT_TYPES.TRACKING_OFF}:${employeeId}:${assignmentId}`;
   if (isDuplicate(dedupKey)) return;

   const minutesAgo = Math.round((Date.now() - lastSeenAt.getTime()) / 60_000);
   const message = `${employeeName} has not sent a location update for ${minutesAgo} minutes.`;

   const alert = await Alert.createAlert({
      companyId, managerId, employeeId, assignmentId,
      type: ALERT_TYPES.TRACKING_OFF,
      message,
   });

   markFired(dedupKey);
   emitAlertNew(companyId, alert);

   // ── Push notification ────────────────────────────────────────────────────
   await sendAlertPushNotification({
      alertType: ALERT_TYPES.TRACKING_OFF,
      managerId,
      title: '⚠️ Tracking OFF',
      body: message,
      data: { alertId: String(alert._id), type: ALERT_TYPES.TRACKING_OFF },
   });

   console.log(`[AlertService] TrackingOff alert created for employee=${employeeName}`);
};

/**
 * Creates MissedCenter alerts + sends push notifications. (F068)
 */
export const createMissedCenterAlerts = async ({
   assignment,
   companyId,
   managerId,
   employeeName,
   centers,
}) => {
   const { VISIT_STATUS } = await import('../models/assignment.model.js');
   const centerMap = new Map(centers.map((c) => [String(c._id), c.name]));
   let alertCount = 0;

   for (const vs of assignment.visitStatuses) {
      if (vs.status === VISIT_STATUS.PENDING || vs.status === VISIT_STATUS.IN_ZONE) {
         const centerIdStr = String(vs.centerId);
         const centerName = centerMap.get(centerIdStr) ?? 'Unknown center';
         const dedupKey = `${ALERT_TYPES.MISSED_CENTER}:${String(assignment._id)}:${centerIdStr}`;

         if (isDuplicate(dedupKey)) continue;

         const message = `${employeeName} did not visit "${centerName}" during their shift.`;

         const alert = await Alert.createAlert({
            companyId, managerId,
            employeeId: String(assignment.employeeId),
            assignmentId: String(assignment._id),
            type: ALERT_TYPES.MISSED_CENTER,
            message,
            centerId: vs.centerId,
            centerName,
         });

         markFired(dedupKey);
         emitAlertNew(companyId, alert);

         // ── Push notification ──────────────────────────────────────────────
         await sendAlertPushNotification({
            alertType: ALERT_TYPES.MISSED_CENTER,
            managerId,
            title: '❌ Missed Center',
            body: message,
            data: { alertId: String(alert._id), type: ALERT_TYPES.MISSED_CENTER },
         });

         alertCount++;
      }
   }

   if (alertCount > 0) {
      console.log(`[AlertService] ${alertCount} MissedCenter alert(s) for employee=${employeeName}`);
   }

   return alertCount;
};

/**
 * Creates an Idle alert. (F070)
 */
export const createIdleAlert = async ({
   employeeId,
   employeeName,
   assignmentId,
   companyId,
   managerId,
   distanceMeters,
   windowMinutes,
}) => {
   const dedupKey = `${ALERT_TYPES.IDLE}:${employeeId}:${assignmentId}`;
   if (isDuplicate(dedupKey)) return;

   const message = `${employeeName} has moved only ${Math.round(distanceMeters)}m in the last ${windowMinutes} minutes.`;

   const alert = await Alert.createAlert({
      companyId, managerId, employeeId, assignmentId,
      type: ALERT_TYPES.IDLE,
      message,
   });

   markFired(dedupKey);
   emitAlertNew(companyId, alert);

   console.log(`[AlertService] Idle alert created for employee=${employeeName}`);
};

/**
 * Creates a LateStart alert. (F075)
 */
export const createLateStartAlert = async ({
   employeeId,
   employeeName,
   assignmentId,
   companyId,
   managerId,
}) => {
   const dedupKey = `${ALERT_TYPES.LATE_START}:${employeeId}:${assignmentId}`;
   if (isDuplicate(dedupKey)) return;

   const message = `${employeeName} has not started their assigned route yet.`;

   const alert = await Alert.createAlert({
      companyId, managerId, employeeId, assignmentId,
      type: ALERT_TYPES.LATE_START,
      message,
   });

   markFired(dedupKey);
   emitAlertNew(companyId, alert);

   console.log(`[AlertService] LateStart alert created for employee=${employeeName}`);
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

const emitAlertNew = (companyId, alert) => {
   try {
      getIO().to(companyRoom(String(companyId))).emit('alert:new', {
         alertId: String(alert._id),
         type: alert.type,
         message: alert.message,
         employeeId: String(alert.employeeId),
         centerId: alert.centerId ? String(alert.centerId) : null,
         centerName: alert.centerName,
         assignmentId: alert.assignmentId ? String(alert.assignmentId) : null,
         triggeredAt: alert.triggeredAt.toISOString(),
      });
   } catch (err) {
      console.error('[AlertService] Socket emit failed:', err.message);
   }
};
