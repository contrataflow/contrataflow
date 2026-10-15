import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ACCESS_CLOCK, ROLE_REPOSITORY } from './ports.js';
import type { AccessClock, RoleRepository } from './ports.js';
import { DEFAULT_ROLES, defaultGrants, seedDefaultRoles } from '../domain/default-roles.js';
import type { DefaultRoleDefinition } from '../domain/default-roles.js';

/** `SeedDefaultRolesCommand`: tenant do contexto da transação do provisionamento. */
export interface SeedDefaultRolesCommand {
  /** Perfis a semear; padrão = os 15 de permissions.md §3.1 (parâmetro só para testes). */
  readonly definitions?: readonly DefaultRoleDefinition[];
}

export interface SeedDefaultRolesResult {
  /** Perfis criados nesta execução (0 em reexecução — FA-01). */
  readonly rolesCreated: number;
  /** Concessões gravadas nesta execução. */
  readonly permissionsGranted: number;
}

let seededCounter: Counter | undefined;

/** `access_default_roles_seeded_total{result}` — execuções do seeder (US-094 · DoD). */
function countSeed(result: 'created' | 'unchanged' | 'failed'): void {
  seededCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('access_default_roles_seeded_total', {
      description: 'Execuções do seeder de perfis padrão por resultado.',
    });
  seededCounter.add(1, { result });
}

/**
 * `SeedDefaultRolesHandler` — seeder `access.defaultRoles` (US-094 · RN-IAM-74..77), chamado pelo
 * checklist de provisionamento (US-099) com o `tx` dele: grava os 15 perfis padrão e a matriz
 * §3.2 de uma vez, idempotente (upsert por `(tenant, key)` e `(tenant, perfil, permissão)`), e
 * audita `role.create` (ator `SYSTEM`, `metadata.seeded`) só para os perfis criados agora. Qualquer
 * falha sobe para o chamador e desfaz a transação inteira (RN-IAM-77).
 */
@Injectable()
export class SeedDefaultRolesHandler {
  private readonly logger = new Logger('Access');

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ACCESS_CLOCK) private readonly clock: AccessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async execute(
    tx: TenantTx,
    command: SeedDefaultRolesCommand = {},
  ): Promise<SeedDefaultRolesResult> {
    const context = requireRequestContext();
    const { tenantId } = context;
    if (tenantId === null) throw new Error('access.defaultRoles exige o tenant do contexto.');
    const definitions = command.definitions ?? DEFAULT_ROLES;
    const startedAt = performance.now();
    try {
      const now = this.clock();
      const drafts = seedDefaultRoles(tenantId, now, newId, definitions);
      const created = await this.roles.insertMissing(
        tx,
        drafts.map((draft) => draft.role),
      );
      const existing = await this.roles.findByKeys(
        tx,
        definitions.map((definition) => definition.key),
      );
      const permissionsGranted = await this.roles.insertMissingGrants(
        tx,
        defaultGrants(existing, definitions, now, newId),
      );
      const permissionsOf = new Map<string, readonly string[]>(
        definitions.map((definition) => [definition.key, definition.permissions]),
      );
      for (const role of created) {
        await this.audit.record(tx, {
          action: 'role.create',
          entityType: 'Role',
          entityId: role.id,
          metadata: {
            key: role.key,
            isSystem: true,
            seeded: true,
            permissionsGranted: [...(permissionsOf.get(role.key) ?? [])],
          },
        });
      }

      const result = { rolesCreated: created.length, permissionsGranted };
      if (created.length === 0) {
        this.logger.warn(
          { event: 'access.default_roles_seed_retry', tenantId, ...result },
          'access.default_roles_seed_retry',
        );
      }
      this.logger.log(
        {
          event: 'access.default_roles_seeded',
          tenantId,
          ...result,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'access.default_roles_seeded',
      );
      countSeed(created.length > 0 ? 'created' : 'unchanged');
      return result;
    } catch (error) {
      countSeed('failed');
      this.logger.error(
        {
          event: 'access.default_roles_seed_failed',
          tenantId,
          errorCode: errorCodeOf(error),
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: context.correlationId,
        },
        'access.default_roles_seed_failed',
      );
      throw error;
    }
  }
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return 'INTERNAL_ERROR';
}
