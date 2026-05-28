/**
 * @file routes/report.routes.js
 * @description Express router for all reporting endpoints.
 *
 * Week 19 additions:
 *  - GET /reports/team
 *  - GET /centers/:id/visits
 *  - GET /reports/pdf
 *
 * @module routes/report
 */

import { Router } from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import { requireRoles } from '../middleware/rbac.middleware.js';
import { USER_ROLES } from '../models/user.model.js';
<<<<<<< HEAD
import { getLocationMapData, getDailyReport, getWeeklyReport } from '../controllers/report.controller.js';
=======
import { getLocationMapData, getDailyReport, getWeeklyReport, getEmployeeHistory } from '../controllers/report.controller.js';
>>>>>>> dc283fc (Initial commit)
import { getTeamReport, getCenterVisitHistory, generatePdfReport } from '../controllers/reportAdvanced.controller.js';

const MANAGER_ROLES = [USER_ROLES.ADMIN, USER_ROLES.MANAGER];

// ─── Location Map Router ──────────────────────────────────────────────────────

export const locationMapRouter = Router();
locationMapRouter.use(verifyToken);
locationMapRouter.get('/map', requireRoles(...MANAGER_ROLES), getLocationMapData);

// ─── Reports Router ───────────────────────────────────────────────────────────

export const reportRouter = Router();
reportRouter.use(verifyToken);
reportRouter.get('/daily', requireRoles(...MANAGER_ROLES), getDailyReport);
reportRouter.get('/weekly', requireRoles(...MANAGER_ROLES), getWeeklyReport);
reportRouter.get('/team', requireRoles(...MANAGER_ROLES), getTeamReport);
reportRouter.get('/pdf', requireRoles(...MANAGER_ROLES), generatePdfReport);
<<<<<<< HEAD
=======
reportRouter.get('/employee-history', verifyToken, getEmployeeHistory);
>>>>>>> dc283fc (Initial commit)

// ─── Centers Router ───────────────────────────────────────────────────────────

export const centerHistoryRouter = Router();
centerHistoryRouter.use(verifyToken);
centerHistoryRouter.get('/:id/visits', requireRoles(...MANAGER_ROLES), getCenterVisitHistory);
