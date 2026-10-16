import type { PermissionCode } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { RoleAssignment } from '../domain/role-assignment.js';
import type { Role, RolePermission, ScopeType } from '../domain/role.js';

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

  // --- Gestão de perfis (US-095) ---------------------------------------------------------------

  /** Perfis do tenant da transação: padrão primeiro, depois por nome. */
  list(tx: TenantTx, filter: RoleListFilter): Promise<Role[]>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<Role | null>;
  /** Perfil com o mesmo nome sem distinção de maiúsculas (RN-IAM-87), exceto `excludingId`. */
  findByName(tx: TenantTx, name: string, excludingId?: string): Promise<Role | null>;
  /** Nomes e chaves de todos os perfis do tenant (nome da cópia — RN-IAM-86). */
  namesAndKeys(tx: TenantTx): Promise<{ names: string[]; keys: string[] }>;
  /** @throws RoleAlreadyExistsError (índices únicos de `key` e `lower(name)`) */
  insert(tx: TenantTx, role: Role): Promise<void>;
  /**
   * Grava o perfil com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError @throws RoleAlreadyExistsError
   */
  update(tx: TenantTx, role: Role, expectedVersion: number): Promise<void>;
  /** Códigos concedidos ao perfil, em ordem alfabética. */
  permissionsOf(tx: TenantTx, roleId: string): Promise<PermissionCode[]>;
  /** Remove as concessões dos códigos informados (diff da matriz — ROL-06). */
  removeGrants(tx: TenantTx, roleId: string, codes: readonly PermissionCode[]): Promise<void>;
  /** Perfis do tenant com as chaves informadas e as respectivas concessões (POL-13). */
  grantsByKeys(tx: TenantTx, keys: readonly string[]): Promise<RoleGrants[]>;
}

export interface RoleListFilter {
  /** Contém, no nome ou na chave, sem diferenciar maiúsculas. */
  readonly search?: string;
  readonly isActive?: boolean;
}

export interface RoleGrants {
  readonly key: string;
  readonly isActive: boolean;
  readonly permissions: readonly PermissionCode[];
}

/** Nome ou chave já usados no tenant (índices únicos de `roles` — RN-IAM-87 · V-02). */
export class RoleAlreadyExistsError extends Error {
  constructor() {
    super('Nome ou chave de perfil já usados no tenant.');
    this.name = 'RoleAlreadyExistsError';
  }
}

/**
 * Vínculos com atribuição vigente por perfil (RN-IAM-84 · SCR-030): implementada pelo repositório
 * de atribuições (US-096).
 */
export interface RoleAssignmentCounter {
  countActive(tx: TenantTx, roleIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export const ROLE_ASSIGNMENT_COUNTER = Symbol('RoleAssignmentCounter');

/** Atribuição inicial do convite (US-091 · RN-IAM-51), no escopo padrão do perfil. */
export interface InitialRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly grantedById: string;
  readonly now: Date;
}

/**
 * `role_assignments` (US-091 grava a inicial do convite; US-096 faz a gestão contínua — ROL-09..12).
 * Toda leitura é do tenant da transação (RLS): id de outro tenant = inexistente.
 */
export interface RoleAssignmentRepository extends RoleAssignmentCounter {
  insertInitial(tx: TenantTx, assignment: InitialRoleAssignment): Promise<void>;
  /**
   * Vínculos com atribuição vigente do perfil (`validFrom ≤ now < validUntil`, não revogada) no
   * tenant da transação — POL-12 conta os `ADMIN_ORGAO` (com `scopeType`, só os desse escopo).
   */
  membershipIdsWithRole(
    tx: TenantTx,
    roleId: string,
    now: Date,
    scopeType?: ScopeType,
  ): Promise<string[]>;
  /**
   * ROL-11 (RN-IAM-94): grava a atribuição; o índice parcial `role_assignments_active_key` decide
   * a corrida de duas atribuições idênticas.
   * @throws RoleAssignmentAlreadyExistsError
   */
  insert(tx: TenantTx, assignment: RoleAssignment): Promise<void>;
  /** Atribuição ativa (não revogada) idêntica (RN-IAM-94), ou `null`. */
  findActiveDuplicate(
    tx: TenantTx,
    key: Pick<
      RoleAssignment,
      'membershipId' | 'roleId' | 'scopeType' | 'scopeOrganizationId' | 'scopeDepartmentId'
    >,
  ): Promise<RoleAssignment | null>;
  findById(tx: TenantTx, id: string): Promise<RoleAssignment | null>;
  /** Não revogadas do vínculo (vigentes, futuras e vencidas), por concessão. */
  listByMembership(tx: TenantTx, membershipId: string): Promise<RoleAssignment[]>;
  /** Não revogadas do perfil, por concessão. */
  listByRole(tx: TenantTx, roleId: string): Promise<RoleAssignment[]>;
  /**
   * ROL-12: grava a revogação condicionada a `expectedVersion` (`version + 1`); `false` se a versão
   * mudou ou a atribuição já foi revogada.
   */
  revoke(tx: TenantTx, revoked: RoleAssignment, expectedVersion: number): Promise<boolean>;
}

/** Corrida de duas atribuições idênticas: o índice único parcial recusou a segunda (RN-IAM-94). */
export class RoleAssignmentAlreadyExistsError extends Error {
  constructor() {
    super('Atribuição ativa idêntica já existe.');
    this.name = 'RoleAssignmentAlreadyExistsError';
  }
}

export const ROLE_ASSIGNMENT_REPOSITORY = Symbol('RoleAssignmentRepository');

export const ROLE_REPOSITORY = Symbol('RoleRepository');

export type AccessClock = () => Date;

export const ACCESS_CLOCK = Symbol('AccessClock');

/** Transações do tenant do contexto (Prisma: `TenantTransaction`; em memória: simulada). */
export interface AccessTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const ACCESS_TRANSACTIONS = Symbol('AccessTransactions');
