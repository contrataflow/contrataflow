import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Etiquetas do processo (US-007 · entities.md §4.4 `Tag`/`ProcessTag` · api/02-processes.md
 * TAG-01..03 e PRC-18). Os MESMOS schemas validam o formulário de SCR-109 (aba "Etiquetas"), o
 * seletor de SCR-006 e os corpos da API. A paleta é a constante única de cores acessíveis
 * (RN-PROC-85): todas passam o contraste AA (4,5:1) com o texto branco do chip.
 */

/** Cor padrão da etiqueta (RN-PROC-85). */
export const DEFAULT_TAG_COLOR = '#64748B';

/** Paleta acessível (`#RRGGBB` maiúsculo): contraste ≥ 4,5:1 com o texto branco do chip. */
export const TAG_PALETTE = [
  '#64748B',
  '#B45309',
  '#B91C1C',
  '#C2410C',
  '#4D7C0F',
  '#15803D',
  '#0F766E',
  '#0369A1',
  '#1D4ED8',
  '#4338CA',
  '#7E22CE',
  '#BE185D',
] as const;
export type TagColor = (typeof TAG_PALETTE)[number];

/** Limites de RN-PROC-85 e RN-PROC-88. */
export const TAG_LIMITS = Object.freeze({
  nameMin: 2,
  nameMax: 40,
  /** Etiquetas por processo (entities.md §4.4). */
  perProcess: 10,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-007. */
export const TAG_MESSAGES = Object.freeze({
  name: 'O nome deve ter entre 2 e 40 caracteres.',
  color: 'Escolha uma das cores disponíveis.',
  nameTaken: 'Já existe uma etiqueta com este nome.',
  limit: 'Use no máximo 10 etiquetas por processo.',
  invalidSet: 'Selecione etiquetas válidas.',
  invalid: 'Revise as etiquetas selecionadas.',
  notFound: 'Não encontrado.',
  notCustodian: 'Somente quem está com o processo pode alterar as etiquetas.',
  forbidden: 'Você não pode alterar as etiquetas deste processo.',
  stale: 'O processo foi alterado por outra pessoa.',
  unavailable: 'Não foi possível salvar as etiquetas agora.',
  inactive: '(inativa)',
  renameWarning: 'Regras de workflow que usam o nome antigo deixarão de reconhecer esta etiqueta.',
});

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const PALETTE = new Set<string>(TAG_PALETTE);

/** Chave de unicidade do nome no tenant (`lower(name)` — RN-PROC-85). */
export function tagNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** RN-PROC-85: 2 a 40 caracteres após o `trim` (mensagem única da V-01). */
export const tagNameSchema = z
  .string({ error: TAG_MESSAGES.name })
  .trim()
  .min(TAG_LIMITS.nameMin, { error: TAG_MESSAGES.name })
  .max(TAG_LIMITS.nameMax, { error: TAG_MESSAGES.name });

/** V-02: `#RRGGBB` (`INVALID_FORMAT`) pertencente à paleta (`INVALID_ENUM`); normaliza para maiúsculas. */
export const tagColorSchema = z
  .string({ error: TAG_MESSAGES.color })
  .trim()
  .superRefine((value, ctx) => {
    if (!HEX_COLOR.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: TAG_MESSAGES.color,
        params: { code: 'INVALID_FORMAT' },
      });
    } else if (!PALETTE.has(value.toUpperCase())) {
      ctx.addIssue({
        code: 'custom',
        message: TAG_MESSAGES.color,
        params: { code: 'INVALID_ENUM' },
      });
    }
  })
  .transform((value) => value.toUpperCase());

/** TAG-02 — corpo de `POST /tags`. ESTRITO; a cor é opcional (padrão `#64748B`). */
export const createTagSchema = z
  .strictObject({ name: tagNameSchema, color: tagColorSchema.optional() })
  .meta({ id: 'CreateTagRequest' });
export type CreateTag = z.output<typeof createTagSchema>;
export type CreateTagInput = z.input<typeof createTagSchema>;

/** TAG-03 — corpo de `PATCH /tags/{id}`: subconjunto estrito dos campos editáveis. */
export const updateTagSchema = z
  .strictObject({
    name: tagNameSchema.optional(),
    color: tagColorSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .meta({ id: 'UpdateTagRequest' });
export type UpdateTag = z.output<typeof updateTagSchema>;
export type UpdateTagInput = z.input<typeof updateTagSchema>;

export const tagIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** TAG-01 (query): `includeInactive` só é atendido para quem tem `TAG_MANAGE` (RN-PROC-91). */
export const tagListQuerySchema = z.strictObject({ includeInactive: booleanQuery });
export type TagListQuery = z.infer<typeof tagListQuerySchema>;

export interface TagSetIssue {
  readonly code: 'OUT_OF_RANGE' | 'DUPLICATE_IN_LIST';
  readonly message: string;
}

/** RN-PROC-88 (V-04/V-05): no máximo 10 etiquetas, sem repetição. */
export function tagSetIssues(tagIds: readonly string[]): TagSetIssue[] {
  const issues: TagSetIssue[] = [];
  if (tagIds.length > TAG_LIMITS.perProcess) {
    issues.push({ code: 'OUT_OF_RANGE', message: TAG_MESSAGES.limit });
  }
  if (new Set(tagIds).size !== tagIds.length) {
    issues.push({ code: 'DUPLICATE_IN_LIST', message: TAG_MESSAGES.invalidSet });
  }
  return issues;
}

/** PRC-18 — corpo de `PUT /processes/{id}/tags`: o conjunto completo final (pode ser vazio). */
export const setProcessTagsSchema = z
  .strictObject({
    tagIds: z.array(z.uuid({ error: TAG_MESSAGES.invalidSet }), { error: TAG_MESSAGES.invalidSet }),
  })
  .superRefine((value, ctx) => {
    for (const issue of tagSetIssues(value.tagIds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tagIds'],
        message: issue.message,
        params: { code: issue.code },
      });
    }
  })
  .meta({ id: 'SetProcessTagsRequest' });
export type SetProcessTags = z.output<typeof setProcessTagsSchema>;
export type SetProcessTagsInput = z.input<typeof setProcessTagsSchema>;

/** `Tag` — resposta de TAG-01/02/03 e item de PRC-18 (api/02-processes.md). */
export const tagSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    color: z.string(),
    isActive: z.boolean(),
    /** Versão da etiqueta: `If-Match` de TAG-03. */
    version: z.int().min(1),
  })
  .meta({ id: 'Tag' });
export type TagDto = z.infer<typeof tagSchema>;

/** PRC-18 — `data` da resposta: as etiquetas do processo (por nome). */
export const processTagsSchema = z.object({ tags: z.array(tagSchema) }).meta({ id: 'ProcessTags' });
export type ProcessTagsDto = z.infer<typeof processTagsSchema>;
