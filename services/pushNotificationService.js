/**
 * @file services/pushNotificationService.js
 * @description Firebase Cloud Messaging push notification sender. (F072)
 *
 * Single Responsibility: sends FCM push notifications to manager devices.
 * Called by alertService.js for critical alerts (MissedCenter, TrackingOff).
 *
 * @module services/pushNotificationService
 */

import { getMessaging } from './firebaseAdmin.js';
import { ALERT_TYPES } from '../models/alert.model.js';

// ─── Priority config ──────────────────────────────────────────────────────────

/**
 * Alert types that trigger push notifications.
 * Idle and LateStart are lower priority — socket events only.
 */
const PUSH_ALERT_TYPES = new Set([
   ALERT_TYPES.MISSED_CENTER,
   ALERT_TYPES.TRACKING_OFF,
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sends a push notification to a single FCM token.
 * Fire-and-forget — errors are logged but never thrown.
 *
 * @param {{
 *   fcmToken: string,
 *   title: string,
 *   body: string,
 *   data?: Record<string, string>,
 * }} params
 * @returns {Promise<void>}
 */
export const sendPushNotification = async ({ fcmToken, title, body, data = {} }) => {
   if (!fcmToken) return;

   try {
      const message = {
         token: fcmToken,
         notification: { title, body },
         data: {
            ...data,
            timestamp: new Date().toISOString(),
         },
         android: {
            priority: 'high',
            notification: {
               sound: 'default',
               channelId: 'alerts',
               priority: 'high',
            },
         },
         apns: {
            payload: {
               aps: {
                  sound: 'default',
                  badge: 1,
               },
            },
         },
      };

      const response = await getMessaging().send(message);
      console.log(`[FCM] Notification sent: ${response}`);
   } catch (err) {
      // Invalid token — log but never crash
      console.error(`[FCM] Failed to send notification: ${err.message}`);
   }
};

/**
 * Sends push notification for an alert if it's a critical type.
 * Looks up the manager's FCM token from the User model.
 *
 * @param {{
 *   alertType: string,
 *   managerId: string,
 *   title: string,
 *   body: string,
 *   data?: Record<string, string>,
 * }} params
 * @returns {Promise<void>}
 */
export const sendAlertPushNotification = async ({
   alertType,
   managerId,
   title,
   body,
   data = {},
}) => {
   if (!PUSH_ALERT_TYPES.has(alertType)) return;

   try {
      const User = (await import('../models/user.model.js')).default;
      const manager = await User.findById(managerId).select('fcmToken').lean();

      if (!manager?.fcmToken) return;

      await sendPushNotification({
         fcmToken: manager.fcmToken,
         title,
         body,
         data,
      });
   } catch (err) {
      console.error(`[FCM] sendAlertPushNotification failed: ${err.message}`);
   }
};
