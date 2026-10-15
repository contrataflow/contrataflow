import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';
import { pageQuerySchema } from '../http/pagination.js';
import { adminEmailSchema } from '../tenancy/tenant.js';

/*
 * Secretarias e setores do órgão (US-102 · entities.md §4 `Department` · api/14-tenant-administration.md
 * DEP-01..09 · RN-TEN-44..51). Schemas compartilhados pela API (corpo/query/resposta) e pelo
 * SCR-032 (aba "Secretarias"). `path`/`depth` são calculados pela aplicação e nunca aceitos do
 * cliente (RN-TEN-45): o parse os descarta em silêncio, como `isActive` na criação.
 */

/** entities.md §2 — `DepartmentType` (DEC-011). */
export const DEPARTMENT_TYPES = [
  'SECRETARIAT',
  'BOARD',
  'DEPARTMENT',
  'DIVISION',
  'SECTOR',
  'COMMITTEE',
  'OTHER',
] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

/** RN-TEN-49: tipos que contam como "Secretaria" (além das raízes do órgão). */
export const SECRETARIAT_TYPES: readonly DepartmentType[] = ['SECRETARIAT', 'BOARD'];

const SELECT_MESSAGE = 'Selecione um valor válido.';

export const DEPARTMENT_NAME_MIN = 3;
export const DEPARTMENT_NAME_MAX = 200;

/** V-07: titular e substituto devem ser pessoas diferentes (RN-TEN-48). */
export const HEAD_DEPUTY_DISTINCT_MESSAGE = 'Titular e substituto devem ser pessoas diferentes.';

/** Sigla (RN-TEN-47): até 30 caracteres, gravada em maiúsculas; única no órgão. */
export const departmentAcronymSchema = z
  .string()
  .trim()
  .min(1, { error: 'Informe a sigla ou deixe o campo vazio.' })
  .max(30, { error: 'Informe no máximo 30 caracteres.' })
  .transform((value) => value.toUpperCase());

const optionalFields = {
  acronym: departmentAcronymSchema.nullish(),
  code: z.string().trim().max(40, { error: 'Informe no máximo 40 caracteres.' }).nullish(),
  email: adminEmailSchema.nullish(),
  phone: z.string().trim().max(20, { error: 'Informe no máximo 20 caracteres.' }).nullish(),
  headUserId: z.uuid({ error: SELECT_MESSAGE }).nullish(),
  deputyUserId: z.uuid({ error: SELECT_MESSAGE }).nullish(),
  sortOrder: z
    .int({ error: 'Informe um número inteiro.' })
    .min(0, { error: 'Informe um número maior ou igual a 0.' })
    .max(100_000, { error: 'Informe no máximo 100000.' })
    .optional(),
};

const nameSchema = trimmedString({ min: DEPARTMENT_NAME_MIN, max: DEPARTMENT_NAME_MAX });
/** Ausente → `REQUIRED` (V-01); fora do enum → `INVALID_ENUM`. */
const typeSchema = z
  .string({ error: 'Informe o tipo.' })
  .pipe(z.enum(DEPARTMENT_TYPES, { error: SELECT_MESSAGE }))
  // O contrato (OpenAPI, lado de entrada) segue mostrando o enum.
  .meta({ enum: [...DEPARTMENT_TYPES] });

/** V-07 no front e na API: titular ≠ substituto quando os dois vêm no corpo. */
function distinctHeadAndDeputy<
  T extends { headUserId?: string | null | undefined; deputyUserId?: string | null | undefined },
>(value: T, ctx: z.RefinementCtx<T>): void {
  if (value.headUserId && value.deputyUserId && value.headUserId === value.deputyUserId) {
    ctx.addIssue({
      code: 'custom',
      path: ['deputyUserId'],
      message: HEAD_DEPUTY_DISTINCT_MESSAGE,
      params: { code: 'NOT_ALLOWED' },
    });
  }
}

/** DEP-03. `parentId` vazio/nulo = raiz do órgão (FA-01). */
export const createDepartmentSchema = z
  .object({
    organizationId: z.uuid({ error: 'Informe o órgão.' }),
    parentId: z.uuid({ error: SELECT_MESSAGE }).nullish(),
    type: typeSchema,
    name: nameSchema,
    ...optionalFields,
  })
  .superRefine(distinctHeadAndDeputy);
export type CreateDepartment = z.output<typeof createDepartmentSchema>;
export type CreateDepartmentInput = z.input<typeof createDepartmentSchema>;

/**
 * DEP-05: campos de DEP-03, todos opcionais (`null` limpa um opcional). `organizationId` e
 * `parentId` são aceitos só iguais aos atuais: órgão não muda e a unidade superior muda pelo
 * DEP-06 (a API responde 422 `NOT_ALLOWED` se diferirem).
 */
export const updateDepartmentSchema = z
  .object({
    organizationId: z.uuid({ error: SELECT_MESSAGE }).optional(),
    parentId: z.uuid({ error: SELECT_MESSAGE }).nullish(),
    type: typeSchema.optional(),
    name: nameSchema.optional(),
    ...optionalFields,
  })
  .superRefine(distinctHeadAndDeputy);
export type UpdateDepartment = z.output<typeof updateDepartmentSchema>;
export type UpdateDepartmentInput = z.input<typeof updateDepartmentSchema>;

/** DEP-06: `parentId` ausente ou nulo = mover para a raiz do órgão. */
export const moveDepartmentSchema = z.object({
  parentId: z.uuid({ error: SELECT_MESSAGE }).nullish(),
});
export type MoveDepartment = z.output<typeof moveDepartmentSchema>;
export type MoveDepartmentInput = z.input<typeof moveDepartmentSchema>;

/** DEP-07/08: corpo vazio (`{}`) ou ausente. */
export const departmentToggleSchema = z.object({}).optional();

export const departmentIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const searchQuery = z
  .string()
  .trim()
  .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
  .max(120, { error: 'Informe no máximo 120 caracteres.' })
  .optional();

/**
 * DEP-01 (query). A resposta é sempre a lista plana na ordem da árvore (pais antes dos filhos;
 * irmãos por `sortOrder` e nome), com `parentId`/`path`/`depth` para o cliente montar a árvore.
 */
export const departmentListQuerySchema = pageQuerySchema.extend({
  organizationId: z.uuid({ error: SELECT_MESSAGE }).optional(),
  isActive: booleanQuery,
  q: searchQuery,
});
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;

/** DEP-02 (query): só unidades ativas (seletores de novos vínculos e processos — RN-TEN-50). */
export const departmentLookupQuerySchema = z.strictObject({
  organizationId: z.uuid({ error: SELECT_MESSAGE }).optional(),
  q: searchQuery,
});
export type DepartmentLookupQuery = z.infer<typeof departmentLookupQuerySchema>;

/** `Department` da resposta (DEP-01, DEP-03..08). */
export const departmentSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  parentId: z.uuid().nullable(),
  type: z.enum(DEPARTMENT_TYPES),
  name: z.string(),
  acronym: z.string().nullable(),
  code: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  headUserId: z.uuid().nullable(),
  deputyUserId: z.uuid().nullable(),
  isActive: z.boolean(),
  /** RN-TEN-49: tipo `SECRETARIAT`/`BOARD` ou raiz do órgão. */
  isSecretariat: z.boolean(),
  sortOrder: z.int(),
  /** Caminho materializado `/<idRaiz>/…/<id>/` (RN-TEN-45). */
  path: z.string(),
  depth: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type DepartmentDto = z.infer<typeof departmentSchema>;

/** Item do DEP-02. */
export const departmentLookupItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(DEPARTMENT_TYPES),
  path: z.string(),
});
export type DepartmentLookupItem = z.infer<typeof departmentLookupItemSchema>;
