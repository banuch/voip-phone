import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Permission, ROLE_LABEL, ROLE_PERMISSIONS, Role } from '@wintek/shared';
import { DatabaseService, type Queryable } from '../../common/db/database.service';

/** Keeps roles/permissions tables identical to the definitions in @wintek/shared. */
export async function syncRbac(q: Queryable) {
  for (const p of Object.values(Permission)) {
    await q.query(`INSERT INTO permissions (code) VALUES ($1) ON CONFLICT DO NOTHING`, [p]);
  }
  for (const r of Object.values(Role)) {
    await q.query(`INSERT INTO roles (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`, [r, ROLE_LABEL[r]]);
    await q.query(`DELETE FROM role_permissions WHERE role_code = $1 AND NOT (permission_code = ANY($2::text[]))`, [r, ROLE_PERMISSIONS[r]]);
    await q.query(`INSERT INTO role_permissions (role_code, permission_code) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [r, ROLE_PERMISSIONS[r]]);
  }
}

@Injectable()
export class RbacSyncService implements OnModuleInit {
  private readonly log = new Logger(RbacSyncService.name);
  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    try {
      await this.db.tx((c) => syncRbac(c));
    } catch (e: any) {
      this.log.error(`RBAC sync failed (are migrations applied?): ${e.message}`);
    }
  }
}
