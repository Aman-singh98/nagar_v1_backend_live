/**
 * @file controllers/user.controller.js
 * @description User self-service endpoints.
 *
 * Endpoints:
 *  POST /users/fcm-token  → register FCM token on login
 *
 * @module controllers/user
 */

import User from '../models/user.model.js';
import { sendSuccess } from '../utils/responseHandler.js';
import AppError from '../utils/appError.js';

// ─── POST /users/fcm-token ────────────────────────────────────────────────────

/**
 * Registers or updates the FCM token for the authenticated user.
 * Called by the mobile app on every login.
 *
 * @type {import('express').RequestHandler}
 */
export const registerFcmToken = async (req, res, next) => {
   try {
      const { fcmToken } = req.body;

      if (!fcmToken || typeof fcmToken !== 'string') {
         return next(new AppError('fcmToken is required and must be a string.', 400));
      }

      await User.findByIdAndUpdate(
         req.user.sub,
         { $set: { fcmToken } },
         { runValidators: false },
      );

      return sendSuccess(res, 200, 'FCM token registered successfully.');
   } catch (error) {
      return next(error);
   }
};
