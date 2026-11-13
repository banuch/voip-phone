import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService, type Queryable } from '../../common/db/database.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { correlationId } from '../../common/http/request-context';
import { redact } from '../../common/http/redact';

export interface AuditActor {
  userId: string | null;
  username: string;
  organizationId: string | null;
}

export interface AuditRecord {
  actor?: AuthUser | AuditActor | null;
  organizationId?: string | null;
  action: string;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  entityType?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
  req?: Request;
}

/**
 * Audit trail writer. Pass a transaction client to make the audit row part of
 * the business change (it commits or rolls back with it). `detail` is always
 * redacted, so secrets can't be written by mistake.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly db: DatabaseService) {}

  async record(r: AuditRecord, tx?: Queryable): Promise<void> {
    const q = tx ?? this.db.pool;
    const ip = r.req?.ip?.replace(/^::ffff:/, '') ?? null;
    const params = [
      r.organizationId !== undefined ? r.organizationId : (r.actor?.organizationId ?? null),
      r.actor?.userId ?? null,
      r.actor?.username ?? null,
      r.action,
      r.entityType ?? null,
      r.entityId ?? null,
      r.outcome ?? 'SUCCESS',
      ip,
      r.req?.headers['user-agent']?.slice(0, 300) ?? null,
      correlationId(),
      r.detail ? JSON.stringify(redact(r.detail)) : null,
    ];
    try {
      await q.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, actor_username, action, entity_type, entity_id, outcome, ip, user_agent, correlation_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        params,
      );
    } catch (e: any) {
      // Inside a transaction the caller must see the failure; standalone writes
      // must not break the request but are logged loudly.
      if (tx) throw e;
      this.log.error(`audit write failed for ${r.action}: ${e.message}`);
    }
  }
}
