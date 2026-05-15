/**
 * @file services/firebaseAdmin.js
 * @description Firebase Admin SDK singleton initialisation.
 *
 * Single Responsibility: initialises the Firebase Admin SDK once and
 * exposes the messaging instance for sending push notifications.
 *
 * Usage:
 *   import { getMessaging } from '../services/firebaseAdmin.js';
 *   await getMessaging().send({ token, notification: { title, body } });
 *
 * @module services/firebaseAdmin
 */

import admin from 'firebase-admin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Singleton guard ──────────────────────────────────────────────────────────

let _messaging = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialises Firebase Admin SDK.
 * Safe to call multiple times — only initialises once.
 * Call once in server.js after DB connects.
 */
export const initFirebaseAdmin = () => {
   if (admin.apps.length > 0) return;

   try {
      const serviceAccount = require('../firebase-service-account.json');

      admin.initializeApp({
         credential: admin.credential.cert(serviceAccount),
      });

      _messaging = admin.messaging();
      console.log('✅  Firebase Admin SDK initialised');
   } catch (err) {
      console.error('❌  Firebase Admin SDK init failed:', err.message);
      console.error('    Make sure firebase-service-account.json exists in project root');
   }
};

// ─── Accessor ─────────────────────────────────────────────────────────────────

/**
 * Returns the Firebase Messaging instance.
 * @returns {import('firebase-admin').messaging.Messaging}
 */
export const getMessaging = () => {
   if (!_messaging) {
      throw new Error('[FirebaseAdmin] Not initialised. Call initFirebaseAdmin() in server.js first.');
   }
   return _messaging;
};
