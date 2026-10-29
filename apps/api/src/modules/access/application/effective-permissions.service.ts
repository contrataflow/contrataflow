import { isPermissionCode } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import { z } from 'zod';

import type { EffectivePermissionsSnapshot } from '#shared/auth/effective-permissions.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import {
  membershipGenerationKey,
  PERMISSION_CACHE_MODULE,
  PERMISSION_CACHE_TTL_SECONDS,
  permissionSnapshotKey,
  TENANT_GENERATION_KEY,
} from '#shared/auth/permission-cache.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
} from './ports.js';
import type {
  AccessClock,
  AccessTransactions,
  RoleAssignmentRepository,
  RoleRepository,
} from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DEFAULT_ROLE_GRANTS, DEFAULT_ROLES } from '../domain/default-roles.js';
import {
  buildEffectivePermissions,
  grantingAssignments,
  subtreeRoots,
} from '../domain/effective-permissions.js';
import type { AssignedRole } from '../domain/effective-permissions.js';
import { isEffective } from '../domain/role-assignment.js';
import type { ScopeType } from '../domain/role.js';

/*
 * `EffectivePermissions(membershipId)` (US-097 · RN-IAM-102 · permissions.md §1.2): calculadas das
 * atribuições vigentes no banco e guardadas no Redis por 5 min, junto com os tokens de geração lidos
 * ANTES do cálculo (`#shared/auth/permission-cache.js`) — retrato com token antigo é descartado, o
 * que impede que um cálculo concorrente a uma revogação volte a conceder acesso. Redis fora → calcula
 * sem cache (`warn authorization.cache_unavailable`, FA-01); banco fora com cache vazio/expirado →
 * 503 `DEPENDENCY_UNAVAILABLE`.
 */

const DEFAULT_GRANTS: Readonly<Record<string, readonly PermissionCode[] | undefined>> =
  DEFAULT_ROLE_GRANTS;

/**
 * Escopo da ponte por chave (modo fake/vínculo sem atribuição gravada): o padrão do perfil
 * (permissions.md §3.1), sem subárvore. `ORGANIZATION` (sem órgão conhecido) e perfil personalizado
 * caem nas lotações — a ponte nunca amplia o acesso.
 */
const BRIDGE_SCOPES: ReadonlyMap<string, ScopeType> = new Map(
  DEFAULT_ROLES.map((role) => [
    role.key,
    role.defaultAssignmentScope === 'TENANT' ? 'TENANT' : 'OWN_DEPARTMENTS',
  ]),
);

const scopeSchema = z.object({
  type: z.enum(['TENANT', 'ORGANIZATION', 'DEPARTMENT', 'OWN_DEPARTMENTS']),
  organizationId: z.string().nullable(),
  departmentId: z.string().nullable(),
  includeSubtree: z.boolean(),
  departmentIds: z.array(z.string()),
});

/** Valor no Redis: o retrato e os tokens de geração com que foi calculado. */
const cachedSchema = z.object({
  v: z.literal(1),
  generations: z.object({ tenant: z.string().nullable(), membership: z.string().nullable() }),
  snapshot: z.object({
    membershipId: z.string(),
    userId: z.string(),
    grants: z.array(
      z.object({
        scope: scopeSchema,
        permissions: z.array(
          z.custom<PermissionCode>((value) => typeof value === 'string' && isPermissionCode(value)),
        ),
      }),
    ),
    ownDepartmentIds: z.array(z.string()),
    headOfDepartmentIds: z.array(z.string()),
    computedAt: z.string(),
  }),
});

interface CacheInstruments {
  readonly lookups: Counter;
}

let instruments: CacheInstruments | undefined;

/** `authorization_cache_lookups_total{result=hit|miss|stale|unavailable}` (DoD: hit/miss). */
function cacheMetrics(): CacheInstruments {
  instruments ??= {
    lookups: metrics
      .getMeter('contrataflow-api')
      .createCounter('authorization_cache_lookups_total', {
        description: 'Leituras do cache de permissões efetivas (US-097), por resultado.',
      }),
  };
  return instruments;
}

export interface MembershipSubject {
  readonly membershipId: string;
  readonly userId: string;
  /** Chaves do registro do vínculo — só a ponte (sem nenhuma atribuição gravada) as usa. */
  readonly roleKeys: readonly string[];
}

@Injectable()
export class EffectivePermissionsService {
  private readonly logger = new Logger('Authorization');

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly assignments: RoleAssignmentRepository,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
    @Inject(ACCESS_CLOCK) private readonly clock: AccessClock,
    private readonly identity: IdentityFacade,
    private readonly references: MembershipReferences,
    private readonly cache: TenantCache,
  ) {}

  /** Do cache quente (sem banco) ou recalculadas e gravadas. */
  async resolve(subject: MembershipSubject): Promise<EffectivePermissionsSnapshot> {
    const keys = [
      permissionSnapshotKey(subject.membershipId),
      TENANT_GENERATION_KEY,
      membershipGenerationKey(subject.membershipId),
    ];
    let generations: { tenant: string | null; membership: string | null } | null = null;
    try {
      const [raw, tenant, membership] = await this.cache.getMany(PERMISSION_CACHE_MODULE, keys);
      generations = { tenant: tenant ?? null, membership: membership ?? null };
      const cached = this.parse(raw ?? null);
      if (cached?.snapshot.membershipId === subject.membershipId) {
        if (
          cached.generations.tenant === generations.tenant &&
          cached.generations.membership === generations.membership
        ) {
          cacheMetrics().lookups.add(1, { result: 'hit' });
          return cached.snapshot;
        }
        cacheMetrics().lookups.add(1, { result: 'stale' });
      } else {
        cacheMetrics().lookups.add(1, { result: 'miss' });
      }
    } catch (error) {
      cacheMetrics().lookups.add(1, { result: 'unavailable' });
      this.cacheUnavailable(subject.membershipId, error);
    }

    const startedAt = performance.now();
    const snapshot = await this.computeOrFail(subject);
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (generations !== null) {
      try {
        await this.cache.set(
          PERMISSION_CACHE_MODULE,
          permissionSnapshotKey(subject.membershipId),
          { v: 1, generations, snapshot },
          { ttlSeconds: PERMISSION_CACHE_TTL_SECONDS },
        );
      } catch (error) {
        this.cacheUnavailable(subject.membershipId, error);
      }
    }
    this.logger.log(
      {
        event: 'authorization.cache_rebuilt',
        membershipId: subject.membershipId,
        durationMs,
        cached: generations !== null,
      },
      'authorization.cache_rebuilt',
    );
    return snapshot;
  }

  private async computeOrFail(subject: MembershipSubject): Promise<EffectivePermissionsSnapshot> {
    try {
      return await this.transactions.read((tx) => this.computeIn(tx, subject, this.clock()));
    } catch (error) {
      const transient = isTransientDatabaseError(error);
      const errorCode =
        error instanceof ApiError
          ? error.code
          : transient
            ? 'DEPENDENCY_UNAVAILABLE'
            : 'INTERNAL_ERROR';
      this.logger.error(
        {
          event: 'authorization.decision_failed',
          errorCode,
          correlationId: requireRequestContext().correlationId,
        },
        'authorization.decision_failed',
      );
      if (transient) throw new DatabaseUnavailableError(error);
      throw error;
    }
  }

  /**
   * Permissões efetivas de OUTRO vínculo calculadas no `tx` do chamador, sem cache (US-047 ·
   * RN-TRAM-08: quem recebe o processo precisa de `PROCESS_VIEW`). Leituras só do tenant do `tx`.
   */
  computeFor(tx: TenantTx, subject: MembershipSubject): Promise<EffectivePermissionsSnapshot> {
    return this.computeIn(tx, subject, this.clock());
  }

  /**
   * O vínculo detém o perfil (pela chave) com escopo `TENANT` numa atribuição que concede agora —
   * vigente, não revogada, perfil ativo — ou, sem nenhuma atribuição gravada, pela ponte das chaves
   * (US-095 · POL-13: o `ADMIN_ORGAO` é isento do anti-escalonamento). No `tx` do chamador, sem
   * cache — a mesma regra de `assignedRoles`.
   */
  async holdsTenantWideRole(
    tx: TenantTx,
    subject: MembershipSubject,
    roleKey: string,
  ): Promise<boolean> {
    const rows = await this.assignments.listByMembership(tx, subject.membershipId);
    if (rows.length === 0 && !(await this.assignments.hasAnyAssignment(tx, subject.membershipId))) {
      if (!subject.roleKeys.includes(roleKey) || BRIDGE_SCOPES.get(roleKey) !== 'TENANT') {
        return false;
      }
      const [bridged] = await this.roles.findByKeys(tx, [roleKey]);
      return bridged?.isActive ?? true;
    }
    const now = this.clock();
    const tenantWide = rows.filter((row) => row.scopeType === 'TENANT' && isEffective(row, now));
    if (tenantWide.length === 0) return false;
    const [role] = await this.roles.findByKeys(tx, [roleKey]);
    return role?.isActive === true && tenantWide.some((row) => row.roleId === role.id);
  }

  private async computeIn(
    tx: TenantTx,
    subject: MembershipSubject,
    now: Date,
  ): Promise<EffectivePermissionsSnapshot> {
    // Em sequência: a transação interativa executa uma consulta por vez.
    const assigned = await this.assignedRoles(tx, subject);
    const granting = grantingAssignments(assigned, now);
    const ownDepartmentIds = await this.identity.departmentsOfUser(tx, subject.userId);
    const subtrees = await this.references.subtreeIds(tx, subtreeRoots(granting, ownDepartmentIds));
    const headOfDepartmentIds = await this.references.departmentsHeadedBy(tx, subject.userId);
    return buildEffectivePermissions({
      membershipId: subject.membershipId,
      userId: subject.userId,
      granting,
      ownDepartmentIds,
      subtrees,
      headOfDepartmentIds,
      now,
    });
  }

  /** Atribuições não revogadas com o perfil ATUAL de cada uma (ou a ponte por chave). */
  private async assignedRoles(tx: TenantTx, subject: MembershipSubject): Promise<AssignedRole[]> {
    const rows = await this.assignments.listByMembership(tx, subject.membershipId);
    if (rows.length === 0 && !(await this.assignments.hasAnyAssignment(tx, subject.membershipId))) {
      return this.bridgeRoles(tx, subject.roleKeys);
    }
    const roles = new Map<string, AssignedRole['role']>();
    for (const roleId of new Set(rows.map((row) => row.roleId))) {
      const role = await this.roles.findById(tx, roleId);
      roles.set(
        roleId,
        role
          ? { isActive: role.isActive, permissions: await this.roles.permissionsOf(tx, roleId) }
          : null,
      );
    }
    return rows.map((row) => ({ assignment: row, role: roles.get(row.roleId) ?? null }));
  }

  /**
   * Ponte do vínculo sem nenhuma atribuição gravada (modo fake, vínculo anterior à US-096): as
   * chaves do registro do vínculo, com as concessões atuais do perfil do tenant (inativo não
   * concede — RN-IAM-84) ou, sem o perfil no tenant, a matriz padrão (§3.2).
   */
  private async bridgeRoles(tx: TenantTx, keys: readonly string[]): Promise<AssignedRole[]> {
    if (keys.length === 0) return [];
    const tenantRoles = new Map(
      (await this.roles.grantsByKeys(tx, keys)).map((role) => [role.key, role]),
    );
    const epoch = new Date(0);
    return keys.map((key) => {
      const role = tenantRoles.get(key);
      return {
        assignment: {
          scopeType: BRIDGE_SCOPES.get(key) ?? 'OWN_DEPARTMENTS',
          scopeOrganizationId: null,
          scopeDepartmentId: null,
          includeSubtree: false,
          validFrom: epoch,
          validUntil: null,
          revokedAt: null,
        },
        role: role
          ? { isActive: role.isActive, permissions: role.permissions }
          : { isActive: true, permissions: DEFAULT_GRANTS[key] ?? [] },
      };
    });
  }

  private parse(raw: string | null): z.infer<typeof cachedSchema> | null {
    if (raw === null) return null;
    try {
      const parsed = cachedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private cacheUnavailable(membershipId: string, error: unknown): void {
    // US-054: a requisição sabe que o cache está fora (campos sensíveis em postura segura).
    updateRequestContext({ permissionCacheUnavailable: true });
    this.logger.warn(
      {
        event: 'authorization.cache_unavailable',
        membershipId,
        errorName: error instanceof Error ? error.name : null,
      },
      'authorization.cache_unavailable',
    );
  }
}
