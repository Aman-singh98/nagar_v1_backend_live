/**
 * @file routes/user.routes.js
 * @description Express router for user self-service endpoints.
 *
 * Route table:
 * ┌──────────────────────────────┬──────────────────────┐
 * │ Route                        │ Roles                │
 * ├──────────────────────────────┼──────────────────────┤
 * │ POST /users/fcm-token        │ all authenticated    │
 * └──────────────────────────────┴──────────────────────┘
 *
 * @module routes/user
 */

import { Router } from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import { registerFcmToken } from '../controllers/user.controller.js';

const userRouter = Router();

userRouter.use(verifyToken);

userRouter.post('/fcm-token', registerFcmToken);

export default userRouter;
