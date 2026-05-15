/**
 * @file socket/socketAuth.middleware.js
 * @description Socket.IO authentication middleware.
 *
 * Mirrors the HTTP verifyToken middleware but for WebSocket handshakes.
 * Runs once per connection — before any event handlers fire.
 *
 * Token delivery:
 *   Client must pass the JWT in the Socket.IO handshake auth object:
 *   ```js
 *   const socket = io(SERVER_URL, {
 *     auth: { token: 'Bearer eyJhbGci...' }
 *   });
 *   ```
 *
 * On success : Attaches decoded payload to socket.user — identical shape
 *              to req.user in HTTP middleware: { sub, email, role, companyId }
 * On failure : Calls next(new Error(...)) — Socket.IO rejects the connection
 *              and the client receives a connect_error event.
 *
 * @module socket/socketAuth.middleware
 */

import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';

// ─── Socket Auth Middleware ───────────────────────────────────────────────────

/**
 * Authenticates a Socket.IO connection using the JWT from handshake.auth.token.
 *
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
export const socketAuthMiddleware = async (socket, next) => {
   try {
      const rawToken = socket.handshake.auth?.token;

      if (!rawToken) {
         return next(new Error('AUTH_MISSING: No token provided in handshake.auth.token'));
      }

      // Strip "Bearer " prefix if present (mirrors HTTP auth header format)
      const token = rawToken.startsWith('Bearer ')
         ? rawToken.slice(7)
         : rawToken;

      // Verify signature + expiry
      let decoded;
      try {
         decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
            algorithms: ['HS256'],
         });
      } catch (jwtError) {
         const message =
            jwtError.name === 'TokenExpiredError'
               ? 'AUTH_EXPIRED: Session expired. Please log in again.'
               : 'AUTH_INVALID: Invalid authentication token.';
         return next(new Error(message));
      }

      // Guard against deleted or deactivated accounts
      const user = await User.findById(decoded.sub).select('isActive').lean();
      if (!user || !user.isActive) {
         return next(new Error('AUTH_DEACTIVATED: Account not found or has been deactivated.'));
      }

      // Attach to socket — available in all event handlers as socket.user
      socket.user = decoded; // { sub, email, role, companyId, iat, exp }

      return next();
   } catch (error) {
      console.error('[SocketAuth] Unexpected error during handshake:', error.message);
      return next(new Error('AUTH_ERROR: Internal authentication error.'));
   }
};
