import type { Request, Response } from 'express';
import { requireAuth } from '../../middlewares/authenticate.js';
import { sendSuccess } from '../../utils/response.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies.js';
import type { AuthResult } from './auth.service.js';
import { authService } from './auth.service.js';
import type { ClientInfo } from './session.service.js';

function clientInfo(req: Request): ClientInfo {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

/** Puts the refresh token in the cookie and everything else in the body. */
function sendSession(res: Response, result: AuthResult, message: string): void {
  setRefreshCookie(res, result.refreshToken);
  // Tells browsers and proxies never to store a response that contains a token.
  res.set('Cache-Control', 'no-store');
  sendSuccess(
    res,
    { accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: result.expiresIn, user: result.user },
    { message },
  );
}

export const authController = {
  async login(req: Request, res: Response) {
    sendSession(res, await authService.login(req.body, clientInfo(req)), 'Signed in');
  },

  async refresh(req: Request, res: Response) {
    try {
      sendSession(res, await authService.refresh(readRefreshCookie(req), clientInfo(req)), 'Session refreshed');
    } catch (error) {
      // A dead refresh token should not linger in the browser.
      clearRefreshCookie(res);
      throw error;
    }
  },

  async logout(req: Request, res: Response) {
    await authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Signed out' });
  },

  async logoutAll(req: Request, res: Response) {
    await authService.logoutAll(requireAuth(req).userId);
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Signed out from all devices' });
  },

  async updateMe(req: Request, res: Response) {
    sendSuccess(res, await authService.updateOwnProfile(requireAuth(req).userId, req.body), { message: 'Profile updated' });
  },

  async me(req: Request, res: Response) {
    sendSuccess(res, await authService.me(requireAuth(req).userId));
  },

  async changePassword(req: Request, res: Response) {
    const result = await authService.changePassword(requireAuth(req).userId, req.body, clientInfo(req));
    sendSession(res, result, 'Password changed. Other sessions have been signed out.');
  },

  async forgotPassword(req: Request, res: Response) {
    await authService.forgotPassword(req.body.email);
    sendSuccess(res, null, {
      statusCode: 202,
      message: 'If an account exists for this email, a password reset link has been sent.',
    });
  },

  async resetPassword(req: Request, res: Response) {
    const { purpose } = await authService.resetPassword(req.body);
    clearRefreshCookie(res);
    sendSuccess(res, null, {
      message: purpose === 'INVITE' ? 'Password set. Your account is active; please sign in.' : 'Password reset. Please sign in.',
    });
  },
};
