import { ITEM_KINDS } from '@contrataflow/types';
import type { ItemKind } from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Itens da contratação (US-006 · entities.md §4.4 `ProcessItem` · api/02-processes.md PRC-13..17).
 * `ProcessItem` é a identidade canônica do item (DEC-019): DFD, ETP, pesquisa de preços e TR
 * referenciam a mesma lista. Os MESMOS schemas validam o formulário do SCR-006 (aba Itens) e o
 * corpo da API. As regras cruzadas (lote com nome, código com sistema e formato do código —
 * RN-PROC-75/77) ficam em `processItemIssues`, chamada pelo schema de criação e, na edição, pelo
 * domínio da API sobre o estado resultante (PATCH parcial).
 */

/** entities.md §2 — `ItemCatalogSystem` (catálogo eletrônico de padronização — art. 19, II). */
export const ITEM_CATALOG_SYSTEMS = ['CATMAT', 'CATSER', 'OTHER'] as const;
export type ItemCatalogSystem = (typeof ITEM_CATALOG_SYSTEMS)[number];

/** Rótulos pt-BR da natureza do item (story · "Campos"). */
export const ITEM_KIND_LABELS: Readonly<Record<ItemKind, string>> = Object.freeze({
  GOOD: 'Bem',
  SERVICE: 'Serviço',
  ENGINEERING_SERVICE: 'Serviço de engenharia',
  WORK: 'Obra',
});

/** Limites dos campos (US-006 · "Campos" · RN-PROC-75/77/83). */
export const PROCESS_ITEM_LIMITS = Object.freeze({
  descriptionMin: 3,
  descriptionMax: 2000,
  notesMax: 2000,
  lotNumberMin: 1,
  lotNumberMax: 999,
  lotNameMax: 150,
  catalogCodeMax: 30,
  /** RN-PROC-83 — `PROCESS_ITEMS_MAX`: itens ativos por processo (lacuna 2 da story). */
  maxItems: 1000,
});

/** Mensagens da tabela de validações da US-006 (V-01..V-09 · FA-01..FA-08). */
export const PROCESS_ITEM_MESSAGES = Object.freeze({
  description: 'Descreva o item (3 a 2.000 caracteres).',
  kind: 'Selecione a natureza do item.',
  unitOfMeasure: 'Selecione uma unidade de medida válida.',
  catalogSystemRequired: 'Informe o sistema do código.',
  lotNumberRequired: 'Informe o número do lote.',
  catalogCodeDigits: 'O código CATMAT/CATSER deve conter apenas números.',
  catalogCodeOther: 'Use apenas letras, números, ".", "-" e "/" (até 30 caracteres).',
  lotRange: 'Informe um lote entre 1 e 999.',
  lotNameLength: 'O nome do lote deve ter no máximo 150 caracteres.',
  notesLength: 'As observações devem ter no máximo 2.000 caracteres.',
  limitReached: 'O processo atingiu o limite de 1.000 itens.',
  readOnly: 'Quantidade e preço de referência vêm dos documentos e não podem ser alterados aqui.',
  invalidOrder: 'A ordem enviada não corresponde aos itens do processo. Recarregue a lista.',
  inUse: 'Este item está em uso em documentos do processo.',
  stale: 'A lista de itens foi alterada por outra pessoa.',
  notCustodian: 'Somente quem está com o processo pode alterar os itens.',
  awaitingApproval: 'Itens não podem ser alterados com o processo aguardando aprovação.',
  unitLocked: 'A unidade não pode ser alterada porque o item já tem quantidades em documentos.',
});

const CATALOG_DIGITS = /^\d{1,30}$/;
const CATALOG_OTHER = /^[A-Za-z0-9./-]{1,30}$/;

const descriptionSchema = z
  .string({ error: PROCESS_ITEM_MESSAGES.description })
  .trim()
  .min(PROCESS_ITEM_LIMITS.descriptionMin, { error: PROCESS_ITEM_MESSAGES.description })
  .max(PROCESS_ITEM_LIMITS.descriptionMax, { error: PROCESS_ITEM_MESSAGES.description });

const kindSchema = z.enum(ITEM_KINDS, { error: PROCESS_ITEM_MESSAGES.kind });
const unitOfMeasureSchema = z.uuid({ error: PROCESS_ITEM_MESSAGES.unitOfMeasure });
const lotNumberSchema = z
  .int({ error: PROCESS_ITEM_MESSAGES.lotRange })
  .min(PROCESS_ITEM_LIMITS.lotNumberMin, { error: PROCESS_ITEM_MESSAGES.lotRange })
  .max(PROCESS_ITEM_LIMITS.lotNumberMax, { error: PROCESS_ITEM_MESSAGES.lotRange });
/** Texto opcional: vazio depois do `trim` = não informado (`null`). */
function optionalText(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, { error: message })
    .transform((value) => (value === '' ? null : value))
    .nullish();
}
const lotNameSchema = optionalText(
  PROCESS_ITEM_LIMITS.lotNameMax,
  PROCESS_ITEM_MESSAGES.lotNameLength,
);
const catalogSystemSchema = z.enum(ITEM_CATALOG_SYSTEMS, {
  error: PROCESS_ITEM_MESSAGES.catalogSystemRequired,
});
const catalogCodeSchema = optionalText(
  PROCESS_ITEM_LIMITS.catalogCodeMax,
  PROCESS_ITEM_MESSAGES.catalogCodeOther,
);
const notesSchema = optionalText(PROCESS_ITEM_LIMITS.notesMax, PROCESS_ITEM_MESSAGES.notesLength);

/** Os campos que as regras cruzadas leem (estado completo do item — criado ou resultante). */
export interface ProcessItemRuleState {
  readonly lotNumber?: number | null | undefined;
  readonly lotName?: string | null | undefined;
  readonly catalogSystem?: ItemCatalogSystem | null | undefined;
  readonly catalogCode?: string | null | undefined;
}

export interface ProcessItemIssue {
  readonly path: 'lotNumber' | 'catalogSystem' | 'catalogCode';
  readonly code: 'CONDITIONAL_REQUIRED' | 'INVALID_FORMAT';
  readonly message: string;
}

/** `CatalogCode` (RN-PROC-77): CATMAT/CATSER só dígitos; OTHER letras, dígitos, `.`, `-`, `/`. */
export function isValidCatalogCode(system: ItemCatalogSystem, code: string): boolean {
  return system === 'OTHER' ? CATALOG_OTHER.test(code) : CATALOG_DIGITS.test(code);
}

/**
 * RN-PROC-75/77 (V-04, V-05): nome do lote exige número; código exige sistema; formato do código
 * pelo sistema. Um erro por campo.
 */
export function processItemIssues(state: ProcessItemRuleState): ProcessItemIssue[] {
  const issues: ProcessItemIssue[] = [];
  const lotName = state.lotName ?? null;
  const lotNumber = state.lotNumber ?? null;
  const catalogSystem = state.catalogSystem ?? null;
  const catalogCode = state.catalogCode ?? null;
  if (lotName !== null && lotNumber === null) {
    issues.push({
      path: 'lotNumber',
      code: 'CONDITIONAL_REQUIRED',
      message: PROCESS_ITEM_MESSAGES.lotNumberRequired,
    });
  }
  if (catalogCode !== null) {
    if (catalogSystem === null) {
      issues.push({
        path: 'catalogSystem',
        code: 'CONDITIONAL_REQUIRED',
        message: PROCESS_ITEM_MESSAGES.catalogSystemRequired,
      });
    } else if (!isValidCatalogCode(catalogSystem, catalogCode)) {
      issues.push({
        path: 'catalogCode',
        code: 'INVALID_FORMAT',
        message:
          catalogSystem === 'OTHER'
            ? PROCESS_ITEM_MESSAGES.catalogCodeOther
            : PROCESS_ITEM_MESSAGES.catalogCodeDigits,
      });
    }
  }
  return issues;
}

function addItemIssues(value: ProcessItemRuleState, ctx: z.RefinementCtx) {
  for (const issue of processItemIssues(value)) {
    ctx.addIssue({
      code: 'custom',
      path: [issue.path],
      message: issue.message,
      params: { code: issue.code },
    });
  }
}

const createProcessItemShape = {
  description: descriptionSchema,
  kind: kindSchema,
  unitOfMeasureId: unitOfMeasureSchema,
  lotNumber: lotNumberSchema.nullish(),
  lotName: lotNameSchema,
  catalogSystem: catalogSystemSchema.nullish(),
  catalogCode: catalogCodeSchema,
  notes: notesSchema,
};

/**
 * PRC-14 — corpo de `POST /processes/{id}/items`. ESTRITO: `sequence` e os campos de referência
 * (`referenceQuantity`, `referenceUnitPrice` e as origens) → 422 `NOT_ALLOWED` (RN-PROC-72 · V-07).
 */
export const createProcessItemSchema = z
  .strictObject(createProcessItemShape)
  .superRefine(addItemIssues)
  .meta({ id: 'CreateProcessItemRequest' });
export type CreateProcessItem = z.output<typeof createProcessItemSchema>;
export type CreateProcessItemInput = z.input<typeof createProcessItemSchema>;

/** Campos editáveis (RN-PROC-72), na ordem canônica do diff e da auditoria. */
export const PROCESS_ITEM_FIELDS = [
  'lotNumber',
  'lotName',
  'kind',
  'description',
  'unitOfMeasureId',
  'catalogSystem',
  'catalogCode',
  'notes',
] as const;
export type ProcessItemField = (typeof PROCESS_ITEM_FIELDS)[number];

/**
 * PRC-15 — corpo de `PATCH /process-items/{itemId}`: subconjunto ESTRITO dos campos editáveis
 * (`null` limpa os opcionais). As regras cruzadas valem sobre o estado resultante (domínio da API).
 */
export const updateProcessItemSchema = z
  .strictObject({
    description: descriptionSchema.optional(),
    kind: kindSchema.optional(),
    unitOfMeasureId: unitOfMeasureSchema.optional(),
    lotNumber: lotNumberSchema.nullish(),
    lotName: lotNameSchema,
    catalogSystem: catalogSystemSchema.nullish(),
    catalogCode: catalogCodeSchema,
    notes: notesSchema,
  })
  .meta({ id: 'UpdateProcessItemRequest' });
export type UpdateProcessItem = z.output<typeof updateProcessItemSchema>;
export type UpdateProcessItemInput = z.input<typeof updateProcessItemSchema>;

/** PRC-17 — `POST /processes/{id}/items/reorder` (RN-PROC-74: todos os itens ativos, sem repetição). */
export const reorderProcessItemsSchema = z
  .strictObject({
    itemIds: z
      .array(z.uuid({ error: PROCESS_ITEM_MESSAGES.invalidOrder }), {
        error: PROCESS_ITEM_MESSAGES.invalidOrder,
      })
      .max(PROCESS_ITEM_LIMITS.maxItems, { error: PROCESS_ITEM_MESSAGES.invalidOrder }),
  })
  .meta({ id: 'ReorderProcessItemsRequest' });
export type ReorderProcessItems = z.output<typeof reorderProcessItemsSchema>;

export const processItemIdParamsSchema = z.strictObject({ itemId: uuidV7Schema });

/** Status dos documentos em que o item referenciado pode ser removido do documento (RN-PROC-79). */
export const ITEM_REFERENCE_EDITABLE_STATUSES = ['DRAFT', 'RETURNED'] as const;

/** Documento (ou pesquisa) que referencia o item (`meta.references` do 409 `ITEM_IN_USE`). */
export const processItemReferenceSchema = z
  .object({
    documentId: z.uuid(),
    code: z.string(),
    typeCode: z.string(),
    status: z.string(),
    /** Em `DRAFT`/`RETURNED`: basta remover o item do documento; senão, reabrir antes (US-065). */
    editable: z.boolean(),
  })
  .meta({ id: 'ProcessItemReference' });
export type ProcessItemReference = z.infer<typeof processItemReferenceSchema>;

/** `ProcessItem` — resposta de PRC-13/14/15/17 (api/02-processes.md, esquema de referência). */
export const processItemSchema = z
  .object({
    id: z.uuid(),
    processId: z.uuid(),
    sequence: z.int().min(1),
    lotNumber: z.int().nullable(),
    lotName: z.string().nullable(),
    kind: z.enum(ITEM_KINDS),
    description: z.string(),
    unitOfMeasure: z.object({ id: z.uuid(), label: z.string() }),
    catalogSystem: z.enum(ITEM_CATALOG_SYSTEMS).nullable(),
    catalogCode: z.string().nullable(),
    notes: z.string().nullable(),
    /** Decimal(18,4) como string; nunca sigiloso (art. 24 — RN-PROC-84). */
    referenceQuantity: z.string().nullable(),
    referenceQuantitySourceDocumentId: z.uuid().nullable(),
    /** `null` também quando mascarado (`referenceUnitPriceMasked` — POL-09). */
    referenceUnitPrice: z.string().nullable(),
    referenceUnitPriceMasked: z.boolean(),
    referenceUnitPriceSourceDocumentId: z.uuid().nullable(),
    /** Documentos e pesquisas que referenciam o item (FA-01/03/04 — unidade travada se houver). */
    references: z.array(processItemReferenceSchema),
    /** Versão do item: `If-Match` de PRC-15/PRC-16. */
    version: z.int().min(1),
  })
  .meta({ id: 'ProcessItem' });
export type ProcessItemDto = z.infer<typeof processItemSchema>;

/** Numeração com lacunas (FA-02): os números atuais não são 1..n. */
export function hasSequenceGaps(sequences: readonly number[]): boolean {
  return [...sequences].sort((a, b) => a - b).some((value, index) => value !== index + 1);
}
