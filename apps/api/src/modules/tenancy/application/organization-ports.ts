import type { TenantTx } from '#shared/database/prisma.js';

import type { Organization } from '../domain/organization.js';

/*
 * Portas da aplicação dos órgãos (US-101): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Sigla já usada no tenant (índice único `(tenant_id, short_name)` — RN-TEN-39 · V-02). */
export class OrganizationShortNameTakenError extends Error {
  constructor(readonly shortName: string) {
    super('Sigla de órgão já usada no tenant.');
    this.name = 'OrganizationShortNameTakenError';
  }
}

/** CNPJ já usado no tenant (índice único `(tenant_id, cnpj)` — RN-TEN-40 · V-04). */
export class OrganizationCnpjTakenError extends Error {
  constructor() {
    super('CNPJ de órgão já usado no tenant.');
    this.name = 'OrganizationCnpjTakenError';
  }
}

export interface OrganizationListFilter {
  readonly isActive?: boolean;
  /** Nome, sigla ou CNPJ (contém, sem diferenciar maiúsculas nem acentos). */
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface OrganizationPage {
  readonly items: readonly Organization[];
  readonly totalItems: number;
}

export interface OrganizationRepository {
  /** Órgãos do tenant da transação, por nome. */
  list(tx: TenantTx, filter: OrganizationListFilter): Promise<OrganizationPage>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<Organization | null>;
  findByShortName(tx: TenantTx, shortName: string): Promise<Organization | null>;
  findByCnpj(tx: TenantTx, cnpj: string): Promise<Organization | null>;
  /** @throws OrganizationShortNameTakenError @throws OrganizationCnpjTakenError */
  insert(tx: TenantTx, organization: Organization): Promise<void>;
  /**
   * Grava o órgão com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError
   * @throws OrganizationShortNameTakenError @throws OrganizationCnpjTakenError
   */
  update(tx: TenantTx, organization: Organization, expectedVersion: number): Promise<void>;
  /** Órgãos ativos do tenant, exceto `excludingId`. */
  countActive(tx: TenantTx, excludingId: string): Promise<number>;
  /** `tenants.primaryOrganizationId` do tenant da transação (`null` até o provisionamento). */
  primaryOrganizationId(tx: TenantTx): Promise<string | null>;
}

export const ORGANIZATION_REPOSITORY = Symbol('OrganizationRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface OrganizationTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const ORGANIZATION_TRANSACTIONS = Symbol('OrganizationTransactions');

/** Resultado da conferência do logotipo (RN-TEN-42 · V-07). */
export type LogoCheck = 'OK' | 'NOT_FOUND' | 'INACTIVE';

/**
 * Anexo do logotipo: `Attachment` `AVAILABLE`, `targetType = TENANT_ASSET`, do mesmo tenant
 * (RN-TEN-42). O módulo `files` (nível 2, US-068) é o dono dos anexos e o implementa; até lá, a
 * implementação padrão recusa qualquer id (`NOT_FOUND`) — a tabela `attachments` ainda não existe.
 */
export interface OrganizationLogoPort {
  check(tx: TenantTx, attachmentId: string): Promise<LogoCheck>;
}

export const ORGANIZATION_LOGO_PORT = Symbol('OrganizationLogoPort');

export type OrganizationClock = () => Date;

export const ORGANIZATION_CLOCK = Symbol('OrganizationClock');
