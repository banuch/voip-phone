/**
 * Call AUTHORIZATION ("may this operator call this ATM?") is deliberately
 * broader than ROUTING ("who should be offered queued work for this ATM?").
 * An operator watching CCTV who sees an incident must be able to call any ATM
 * they are responsible for, even when routing would currently prefer someone
 * else. An operator is authorized for an ATM when ANY of:
 *
 *   - they are its static primary or backup operator,
 *   - an unexpired, unrevoked supervisor override points the ATM at them,
 *   - they cover the ATM's region AND (they have no group restriction OR the
 *     ATM is in one of their groups).
 *
 * Holders of call:initiate:any (supervisors) may call any ATM in their org.
 * Organization equality is enforced separately and always.
 */
export const OPERATOR_AUTHORIZED_FOR_ATM_SQL = (op: string, atm: string) => `(
  EXISTS (SELECT 1 FROM atm_assignments aa WHERE aa.atm_id = ${atm} AND (aa.primary_operator_id = ${op} OR aa.backup_operator_id = ${op}))
  OR EXISTS (SELECT 1 FROM assignment_overrides ao WHERE ao.atm_id = ${atm} AND ao.operator_id = ${op}
              AND ao.revoked_at IS NULL AND now() >= ao.starts_at AND now() < ao.ends_at)
  OR (EXISTS (SELECT 1 FROM operator_regions orr JOIN atm_devices az ON az.id = ${atm} WHERE orr.operator_id = ${op} AND orr.region_id = az.region_id)
      AND (NOT EXISTS (SELECT 1 FROM operator_groups og WHERE og.operator_id = ${op})
           OR EXISTS (SELECT 1 FROM operator_groups og JOIN atm_group_members gm ON gm.group_id = og.group_id
                       WHERE og.operator_id = ${op} AND gm.atm_id = ${atm})))
)`;
