import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits by user when authenticated, by IP otherwise. An operations
 * center puts many operators behind one NAT address; per-IP limits would let
 * one busy console starve its colleagues (e.g. everyone signing in at shift
 * change). Runs after JwtAuthGuard so req.user is known.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.userId ? `user:${req.user.userId}` : `ip:${req.ip}`;
  }
}
