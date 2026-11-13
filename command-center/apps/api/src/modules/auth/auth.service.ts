import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { permissionsForRoles, type Role } from '@wintek/shared';
import { DatabaseService } from '../../common/db/database.service';
import type { AccessTokenClaims } from '../../common/auth/auth-user';
import { DomainError } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { config } from '../../config';
import { DUMMY_HASH, verifyPassword } from './password';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface SessionTokens {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: SessionUser;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  organizationId: string | null;
  organizationName: string | null;
  roles: Role[];
  permissions: string[];
  operatorId: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, req: Request): Promise<SessionTokens> {
    const u = await this.db.one(
      `SELECT u.id, u.username, u.organization_id, u.password_hash, u.status, u.locked_until, u.failed_logins
         FROM users u WHERE u.username = $1 AND u.deleted_at IS NULL`,
      [username],
    );
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
    const actor = { userId: u?.id ?? null, username, organizationId: u?.organization_id ?? null };
    const fail = async (reason: string, code = 'INVALID_CREDENTIALS') => {
      await this.audit.record({ actor, action: 'auth.login.failed', outcome: 'FAILURE', entityType: 'user', entityId: u?.id, detail: { reason }, req });
      // Same message for every cause so the response doesn't reveal which usernames exist.
      throw new UnauthorizedException({ code, message: code === 'ACCOUNT_LOCKED' ? 'Account temporarily locked' : 'Invalid username or password' });
    };
    if (!u) return fail('unknown user');
    if (u.locked_until && new Date(u.locked_until) > new Date()) return fail('locked', 'ACCOUNT_LOCKED');
    if (u.status !== 'ACTIVE') return fail(`status ${u.status}`);
    if (!ok) {
      await this.db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [u.id, MAX_FAILED, LOCK_MINUTES],
      );
      return fail(u.failed_logins + 1 >= MAX_FAILED ? 'bad password; account locked' : 'bad password');
    }
    await this.db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
    const tokens = await this.issue(u.id, randomUUID(), req);
    await this.audit.record({ actor, action: 'auth.login', entityType: 'user', entityId: u.id, req });
    return tokens;
  }

  /**
   * Rotating refresh tokens. Presenting an already-rotated token means it was
   * copied: the whole family is revoked and the user must sign in again.
   */
  async refresh(token: string | undefined, req: Request): Promise<SessionTokens> {
    if (!token) throw new UnauthorizedException({ code: 'REFRESH_REQUIRED', message: 'No refresh token' });
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at, u.status, u.username, u.organization_id
             FROM refresh_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = $1 FOR UPDATE OF t`,
          [sha256(token)],
        )
      ).rows[0];
      if (!row) throw new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Session expired' });
      if (row.rotated_at || row.revoked_at) {
        await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
        await this.audit.record(
          {
            actor: { userId: row.user_id, username: row.username, organizationId: row.organization_id },
            action: 'auth.refresh.reuse_detected',
            outcome: 'DENIED',
            entityType: 'user',
            entityId: row.user_id,
            req,
          },
          c,
        );
        throw new UnauthorizedException({ code: 'REFRESH_REUSED', message: 'Session revoked, please sign in again' });
      }
      if (new Date(row.expires_at) < new Date() || row.status !== 'ACTIVE') {
        throw new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Session expired' });
      }
      await c.query(`UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1`, [row.id]);
      return this.issue(row.user_id, row.family_id, req, c);
    });
  }

  async logout(token: string | undefined, req: Request) {
    if (!token) return;
    const r = await this.db.one<{ family_id: string; user_id: string; username: string; organization_id: string | null }>(
      `SELECT t.family_id, t.user_id, u.username, u.organization_id
         FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
      [sha256(token)],
    );
    if (!r) return;
    await this.db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [r.family_id]);
    await this.audit.record({
      actor: { userId: r.user_id, username: r.username, organizationId: r.organization_id },
      action: 'auth.logout',
      entityType: 'user',
      entityId: r.user_id,
      req,
    });
  }

  async sessionUser(userId: string, q: Pick<DatabaseService['pool'], 'query'> = this.db.pool): Promise<SessionUser> {
    const u = (
      await q.query(
        `SELECT u.id, u.username, u.display_name, u.organization_id, o.name AS org_name, op.id AS operator_id,
                coalesce(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN operators op ON op.user_id = u.id AND op.deleted_at IS NULL AND op.status = 'ACTIVE'
           LEFT JOIN user_roles ur ON ur.user_id = u.id
          WHERE u.id = $1
          GROUP BY u.id, o.name, op.id`,
        [userId],
      )
    ).rows[0];
    if (!u) throw new DomainError(HttpStatus.UNAUTHORIZED, 'USER_GONE', 'User no longer exists');
    const roles = u.roles as Role[];
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      organizationId: u.organization_id,
      organizationName: u.org_name,
      roles,
      permissions: [...permissionsForRoles(roles)],
      operatorId: u.operator_id,
    };
  }

  private async issue(userId: string, familyId: string, req: Request, q: Pick<DatabaseService['pool'], 'query'> = this.db.pool): Promise<SessionTokens> {
    const user = await this.sessionUser(userId, q);
    const claims: AccessTokenClaims = {
      sub: user.id,
      usr: user.username,
      org: user.organizationId,
      roles: user.roles,
      op: user.operatorId,
      typ: 'access',
    };
    const ttl = config().JWT_ACCESS_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: ttl, algorithm: 'HS256' });
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + config().REFRESH_TTL_DAYS * 86_400_000);
    await q.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, familyId, sha256(refreshToken), refreshExpiresAt, req.headers['user-agent']?.slice(0, 300) ?? null, req.ip?.replace(/^::ffff:/, '') ?? null],
    );
    return { accessToken, accessExpiresIn: ttl, refreshToken, refreshExpiresAt, user };
  }
}
