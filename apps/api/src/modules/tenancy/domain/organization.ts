import type {
  CreateOrganization,
  OrganizationType,
  UpdateOrganization,
} from '@contrataflow/validation';

import type { AuditChange } from '#shared/audit/audit-trail.js';

/*
 * `Organization` (entities.md §4 · US-101 · RN-TEN-38..43). Funções puras sobre um registro
 * imutável: nada aqui lê banco, relógio ou contexto. Formatos (sigla, CNPJ, https, UF, CEP) são
 * dos schemas Zod compartilhados; aqui ficam as regras que dependem do estado do tenant.
 */

export interface Organization {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  /** Sigla em maiúsculas — token `{org}` da numeração (DEC-028). */
  readonly shortName: string;
  /** 14 posições, sem máscara. */
  readonly cnpj: string;
  readonly type: OrganizationType;
  readonly isActive: boolean;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly addressStreet: string | null;
  readonly addressNumber: string | null;
  readonly addressComplement: string | null;
  readonly addressDistrict: string | null;
  readonly addressCity: string | null;
  readonly addressState: string | null;
  readonly addressZipCode: string | null;
  readonly ibgeCityCode: string | null;
  readonly logoAttachmentId: string | null;
  /** Somente leitura pela API (RN-TEN-43). */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Campos de cadastro que a edição pode alterar (ORG-04), na ordem de `changedFields`. */
export const ORGANIZATION_UPDATABLE_FIELDS = [
  'name',
  'shortName',
  'cnpj',
  'type',
  'isActive',
  'email',
  'phone',
  'website',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'ibgeCityCode',
  'logoAttachmentId',
] as const satisfies readonly (keyof Organization)[];
export type OrganizationUpdatableField = (typeof ORGANIZATION_UPDATABLE_FIELDS)[number];

/** Violação de RN-TEN-41: inativar o órgão principal ou o único órgão ativo do tenant. */
export class PrimaryOrganizationRequiredError extends Error {
  constructor(readonly reason: 'PRIMARY' | 'LAST_ACTIVE') {
    super(
      reason === 'PRIMARY'
        ? 'O órgão principal do tenant não pode ser inativado.'
        : 'O único órgão ativo do tenant não pode ser inativado.',
    );
    this.name = 'PrimaryOrganizationRequiredError';
  }
}

export interface CreateOrganizationContext {
  readonly id: string;
  readonly tenantId: string;
  readonly now: Date;
  readonly userId: string | null;
}

/** `Organization.create` (RN-TEN-38): ativo, `metadata` vazio (RN-TEN-43), versão 1. */
export function createOrganization(
  input: CreateOrganization,
  context: CreateOrganizationContext,
): Organization {
  return {
    id: context.id,
    tenantId: context.tenantId,
    name: input.name,
    shortName: input.shortName,
    cnpj: input.cnpj,
    type: input.type,
    isActive: true,
    email: input.email ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    addressStreet: input.addressStreet ?? null,
    addressNumber: input.addressNumber ?? null,
    addressComplement: input.addressComplement ?? null,
    addressDistrict: input.addressDistrict ?? null,
    addressCity: input.addressCity ?? null,
    addressState: input.addressState ?? null,
    addressZipCode: input.addressZipCode ?? null,
    ibgeCityCode: input.ibgeCityCode ?? null,
    logoAttachmentId: null,
    metadata: {},
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}

export interface UpdateOrganizationContext {
  readonly now: Date;
  readonly userId: string | null;
  /** O órgão é `tenants.primaryOrganizationId`. */
  readonly isPrimary: boolean;
  /** Órgãos ativos do tenant EXCETO este. */
  readonly otherActiveCount: number;
}

export interface OrganizationUpdateResult {
  readonly next: Organization;
  /** Campos cujo valor mudou, na ordem de `ORGANIZATION_UPDATABLE_FIELDS`. */
  readonly changedFields: readonly OrganizationUpdatableField[];
  /** Valor anterior e novo de cada campo alterado (auditoria `organization.update`). */
  readonly changes: readonly AuditChange[];
  /** O `logoAttachmentId` mudou e é um anexo novo a validar (RN-TEN-42). */
  readonly logoToValidate: string | null;
}

/**
 * `Organization.update` (RN-TEN-38..43): aplica só o que o cliente enviou e mudou. `null` limpa um
 * campo opcional; um campo obrigatório nunca fica vazio (o schema já o barra). Inativar o órgão
 * principal ou o único ativo → `PrimaryOrganizationRequiredError` (RN-TEN-41).
 */
export function updateOrganization(
  current: Organization,
  patch: UpdateOrganization,
  context: UpdateOrganizationContext,
): OrganizationUpdateResult {
  const changedFields: OrganizationUpdatableField[] = [];
  const changes: AuditChange[] = [];
  const draft: Record<string, unknown> = { ...current };

  for (const field of ORGANIZATION_UPDATABLE_FIELDS) {
    const sent = patch[field];
    if (sent === undefined) continue;
    const before = current[field];
    const after = sent;
    if (before === after) continue;
    draft[field] = after;
    changedFields.push(field);
    changes.push({ path: field, old: before, new: after });
  }

  if (draft.isActive === false && current.isActive) {
    if (context.isPrimary) throw new PrimaryOrganizationRequiredError('PRIMARY');
    if (context.otherActiveCount === 0) throw new PrimaryOrganizationRequiredError('LAST_ACTIVE');
  }

  const next: Organization = {
    ...(draft as unknown as Organization),
    ...(changedFields.length > 0 ? { updatedAt: context.now, updatedById: context.userId } : {}),
  };
  const logoToValidate =
    changedFields.includes('logoAttachmentId') && next.logoAttachmentId !== null
      ? next.logoAttachmentId
      : null;
  return { next, changedFields, changes, logoToValidate };
}
