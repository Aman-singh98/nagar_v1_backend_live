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
     let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
   serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
   serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} else {
   serviceAccount = require('../firebase-service-account.json');
}

      admin.initializeApp({
         credential: admin.credential.cert(serviceAccount),
      });

      _messaging = admin.messaging();
      console.log('✅  Firebase Admin SDK initialised');
   } catch (err) {
      console.error('❌  Firebase Admin SDK init failed:', err.message);
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
