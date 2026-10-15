import type { TenantTx } from '#shared/database/prisma.js';

import type { Role, RolePermission } from '../domain/role.js';

/*
 * Portas da aplicação do módulo `access` (US-094): implementadas em `infrastructure/` (Prisma) e
 * em memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface RoleRepository {
  /**
   * Semeadura idempotente (RN-IAM-76): grava só os perfis cuja `key` o tenant ainda não tem —
   * `ON CONFLICT DO NOTHING` no índice `(tenant_id, key)`, que também serializa execuções
   * simultâneas. Devolve SOMENTE os perfis criados por esta chamada.
   */
  insertMissing(tx: TenantTx, roles: readonly Role[]): Promise<Role[]>;
  /** Perfis do tenant da transação com as chaves informadas. */
  findByKeys(tx: TenantTx, keys: readonly string[]): Promise<Role[]>;
  /** Concessões ausentes por `(tenant_id, role_id, permission_code)`; devolve quantas gravou. */
  insertMissingGrants(tx: TenantTx, grants: readonly RolePermission[]): Promise<number>;
}

export const ROLE_REPOSITORY = Symbol('RoleRepository');

export type AccessClock = () => Date;

export const ACCESS_CLOCK = Symbol('AccessClock');
