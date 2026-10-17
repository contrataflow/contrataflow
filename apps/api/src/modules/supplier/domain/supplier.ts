import { displaySupplierDocument } from '@contrataflow/validation';
import type {
  CreateSupplier,
  SupplierDocumentType,
  UpdateSupplier,
} from '@contrataflow/validation';

import type { AuditChange } from '#shared/audit/audit-trail.js';

/*
 * `Supplier` (entities.md §4 · US-025 · RN-PRICE-14..20). Funções puras sobre um registro imutável:
 * nada aqui lê banco, relógio, contexto nem chaves. Formatos e tamanhos são dos schemas Zod
 * compartilhados; aqui ficam as regras do agregado (documento imutável, o que a edição altera e o
 * que a auditoria pode mostrar). O documento chega já normalizado e protegido (hash/cifra) — quem
 * conhece as chaves é a camada de aplicação.
 */

export interface Supplier {
  readonly id: string;
  readonly tenantId: string;
  readonly documentType: SupplierDocumentType;
  /** CNPJ/estrangeiro em claro; CPF sempre mascarado (`***.456.789-**` — RN-PRICE-16). */
  readonly documentNumber: string;
  /** Só CPF: número cifrado (AES-256-GCM, envelope — DEC-086). */
  readonly documentNumberEncrypted: Buffer | null;
  /** Blind index (HMAC) do número normalizado — unicidade e SUP-06 (RN-PRICE-17). */
  readonly documentNumberHash: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly contactName: string | null;
  readonly addressStreet: string | null;
  readonly addressNumber: string | null;
  readonly addressComplement: string | null;
  readonly addressDistrict: string | null;
  readonly addressCity: string | null;
  readonly addressState: string | null;
  readonly addressZipCode: string | null;
  readonly isActive: boolean;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  /** Exclusão lógica (RN-PRICE-19); registros excluídos nunca saem do repositório. */
  readonly deletedAt: Date | null;
  readonly version: number;
}

/** Documento já normalizado e protegido, entregue pela aplicação. */
export interface ProtectedDocument {
  /** Número sem máscara (CNPJ em maiúsculas, CPF só dígitos, estrangeiro com trim). */
  readonly normalized: string;
  readonly encrypted: Buffer | null;
  readonly hash: string;
}

/** Campos que a edição (SUP-04) pode alterar, na ordem de `changedFields`. */
export const SUPPLIER_UPDATABLE_FIELDS = [
  'legalName',
  'tradeName',
  'email',
  'phone',
  'website',
  'contactName',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'notes',
  'isActive',
] as const satisfies readonly (keyof Supplier)[];
export type SupplierUpdatableField = (typeof SUPPLIER_UPDATABLE_FIELDS)[number];

/**
 * Dados de contato, endereço e observações são dados pessoais em potencial: a trilha registra QUE
 * o campo mudou, nunca o valor (Logs/Auditoria da US-025).
 */
const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'email',
  'phone',
  'contactName',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'notes',
]);
export const REDACTED_VALUE = '[alterado]';

const OPTIONAL_CREATE_FIELDS = [
  'tradeName',
  'email',
  'phone',
  'website',
  'contactName',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'notes',
] as const satisfies readonly (keyof CreateSupplier & keyof Supplier)[];

export interface CreateSupplierContext {
  readonly id: string;
  readonly tenantId: string;
  readonly document: ProtectedDocument;
  readonly now: Date;
  readonly userId: string | null;
}

/** `Supplier.create` (RN-PRICE-14): ativo, versão 1, documento exibível (CPF mascarado). */
export function createSupplier(input: CreateSupplier, context: CreateSupplierContext): Supplier {
  const optional = Object.fromEntries(
    OPTIONAL_CREATE_FIELDS.map((field) => [field, input[field] ?? null]),
  ) as Pick<Supplier, (typeof OPTIONAL_CREATE_FIELDS)[number]>;
  return {
    id: context.id,
    tenantId: context.tenantId,
    documentType: input.documentType,
    documentNumber: displaySupplierDocument(input.documentType, context.document.normalized),
    documentNumberEncrypted: context.document.encrypted,
    documentNumberHash: context.document.hash,
    legalName: input.legalName,
    ...optional,
    isActive: true,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    deletedAt: null,
    version: 1,
  };
}

/** Campos da criação na auditoria: sem contato/endereço; CPF só pelo hash (`supplier.create`). */
export function createAuditChanges(supplier: Supplier): AuditChange[] {
  const changes: AuditChange[] = [
    { path: 'documentType', old: null, new: supplier.documentType },
    supplier.documentType === 'CPF'
      ? { path: 'documentNumberHash', old: null, new: supplier.documentNumberHash }
      : { path: 'documentNumber', old: null, new: supplier.documentNumber },
    { path: 'legalName', old: null, new: supplier.legalName },
  ];
  if (supplier.tradeName !== null) {
    changes.push({ path: 'tradeName', old: null, new: supplier.tradeName });
  }
  return changes;
}

export interface UpdateSupplierContext {
  readonly now: Date;
  readonly userId: string | null;
}

export interface UpdateSupplierResult {
  readonly next: Supplier;
  /** Campos alterados, na ordem de `SUPPLIER_UPDATABLE_FIELDS`. */
  readonly changedFields: readonly SupplierUpdatableField[];
  /** Valores anterior/novo para a auditoria, com o conteúdo pessoal redigido. */
  readonly changes: readonly AuditChange[];
}

/** Valor do patch para o campo: ausente = mantém; `null` = limpa (campos opcionais). */
function patched(current: Supplier, patch: UpdateSupplier, field: SupplierUpdatableField): unknown {
  const value = (patch as Record<string, unknown>)[field];
  return value === undefined ? current[field] : value;
}

/**
 * SUP-04 (FA-01/FA-02): aplica o patch. Documento e tipo são imutáveis (V-07) — a conferência com o
 * valor atual é da aplicação (precisa do blind index). Nada mudou → `changedFields` vazio e o
 * registro volta idêntico (200 sem nova versão, auditoria nem evento).
 */
export function updateSupplier(
  current: Supplier,
  patch: UpdateSupplier,
  context: UpdateSupplierContext,
): UpdateSupplierResult {
  const values = Object.fromEntries(
    SUPPLIER_UPDATABLE_FIELDS.map((field) => [field, patched(current, patch, field)]),
  ) as Pick<Supplier, SupplierUpdatableField>;
  const changedFields = SUPPLIER_UPDATABLE_FIELDS.filter(
    (field) => values[field] !== current[field],
  );
  if (changedFields.length === 0) return { next: current, changedFields, changes: [] };

  const changes = changedFields.map((field): AuditChange => {
    const redact = REDACTED_FIELDS.has(field);
    return {
      path: field,
      old: redact ? REDACTED_VALUE : current[field],
      new: redact ? REDACTED_VALUE : values[field],
    };
  });
  return {
    next: { ...current, ...values, updatedAt: context.now, updatedById: context.userId },
    changedFields,
    changes,
  };
}
