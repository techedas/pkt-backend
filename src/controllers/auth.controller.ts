import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';
import { authService } from '../services/auth/auth.service';
import { ok } from '../utils/response';

const REFRESH_COOKIE = 'pkt_rt';

const cookieOptions = (expires?: Date): CookieOptions => ({
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'strict',
  path: '/api/auth',
  ...(expires ? { expires } : {}),
});

const clientOf = (req: Request) => ({ ipAddress: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });

/** The refresh token travels in an httpOnly cookie; a body value is accepted for API clients. */
const refreshTokenOf = (req: Request): string | undefined =>
  (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body?.refreshToken as string | undefined);

function sendSession(res: Response, session: Awaited<ReturnType<typeof authService.login>>, message: string) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(session.refreshTokenExpiresAt));
  const { refreshToken: _omit, ...body } = session;
  return ok(res, body, message);
}

export const authController = {
  async login(req: Request, res: Response) {
    const session = await authService.login(req.body.identifier, req.body.password, clientOf(req));
    return sendSession(res, session, 'Login successful');
  },

  async refresh(req: Request, res: Response) {
    const session = await authService.refresh(refreshTokenOf(req), clientOf(req));
    return sendSession(res, session, 'Session refreshed');
  },

  async logout(req: Request, res: Response) {
    await authService.logout(refreshTokenOf(req));
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    return ok(res, null, 'Logged out successfully');
  },

  async me(req: Request, res: Response) {
    return ok(res, await authService.me(req.user!.id));
  },

  async forgotPassword(req: Request, res: Response) {
    const { devResetToken } = await authService.forgotPassword(req.body.identifier, clientOf(req));
    return ok(
      res,
      devResetToken ? { devResetToken } : null,
      'If an account exists for these details, password reset instructions have been sent.',
    );
  },

  async resetPassword(req: Request, res: Response) {
    await authService.resetPassword(req.body.token, req.body.newPassword, clientOf(req));
    return ok(res, null, 'Password has been reset. Please log in with your new password.');
  },

  async changePassword(req: Request, res: Response) {
    await authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword, clientOf(req));
    return ok(res, null, 'Password changed successfully');
  },
};
