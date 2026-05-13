import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Guard that requires the `x-api-key` header to match `process.env.API_KEY`.
 *
 * - If `API_KEY` is unset/empty, the guard logs a single warning on first hit
 *   and allows the request through. This keeps local dev frictionless while
 *   making it loud-and-clear that the env var must be set in production.
 * - The header comparison is done in constant time via `crypto.timingSafeEqual`
 *   (after padding both buffers to equal length) to avoid trivial timing
 *   side-channels.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private warnedDevMode = false;

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.API_KEY ?? '';

    if (!expected) {
      if (!this.warnedDevMode) {
        this.warnedDevMode = true;
        this.logger.warn(
          'API_KEY is not set — running in DEV MODE. All API endpoints are unprotected. ' +
            'Set API_KEY in production.',
        );
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const headerValue = req.header('x-api-key') ?? '';

    if (!ApiKeyGuard.constantTimeEquals(headerValue, expected)) {
      throw new UnauthorizedException('Invalid or missing x-api-key header');
    }

    return true;
  }

  /**
   * Constant-time string equality. Buffers of different lengths are padded
   * to the longer length before comparison so `timingSafeEqual` never throws,
   * and the length-mismatch case still takes the same amount of work as
   * a mismatched-content case.
   */
  private static constantTimeEquals(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    const len = Math.max(aBuf.length, bBuf.length);
    const aPad = Buffer.alloc(len, 0);
    const bPad = Buffer.alloc(len, 0);
    aBuf.copy(aPad);
    bBuf.copy(bPad);
    // timingSafeEqual still does its constant-time compare; we then AND with
    // the length-equality check so a length mismatch never returns true.
    const eq = timingSafeEqual(aPad, bPad);
    return eq && aBuf.length === bBuf.length;
  }
}
