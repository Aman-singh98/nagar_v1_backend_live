/**
 * @file routes/alert.routes.js
 * @description Express router for Alert endpoints.
 *
 * Route table:
 * ┌──────────────────────────────────────────┬───────────────────┐
 * │ Route                                    │ Roles             │
 * ├──────────────────────────────────────────┼───────────────────┤
 * │ GET    /alerts                           │ admin, manager    │
 * │ GET    /alerts/count                     │ admin, manager    │
 * │ PATCH  /alerts/acknowledge-all           │ admin, manager    │
 * │ PATCH  /alerts/:id/acknowledge           │ admin, manager    │
 * └──────────────────────────────────────────┴───────────────────┘
 *
 * @module routes/alert
 */

import { Router } from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import { requireRoles } from '../middleware/rbac.middleware.js';
import { USER_ROLES } from '../models/user.model.js';
import {
   listAlerts,
   getAlertCount,
   acknowledgeAlert,
   acknowledgeAllAlerts,
} from '../controllers/alert.controller.js';

const alertRouter = Router();

alertRouter.use(verifyToken);

// Count must be before /:id to avoid route collision
alertRouter.get('/count',
   requireRoles(USER_ROLES.ADMIN, USER_ROLES.MANAGER),
   getAlertCount,
);

alertRouter.get('/',
   requireRoles(USER_ROLES.ADMIN, USER_ROLES.MANAGER),
   listAlerts,
);

alertRouter.patch('/acknowledge-all',
   requireRoles(USER_ROLES.ADMIN, USER_ROLES.MANAGER),
   acknowledgeAllAlerts,
);

alertRouter.patch('/:id/acknowledge',
   requireRoles(USER_ROLES.ADMIN, USER_ROLES.MANAGER),
   acknowledgeAlert,
);

export default alertRouter;
