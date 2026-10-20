import { z } from 'zod';

import { termSchema } from './term.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { DOCUMENT_STATUSES } from '../document/document-type.js';
import {
  IMPORT_MAPPING_MODES,
  MAX_TEMPLATE_SECTIONS,
  SECTION_KEY_MAX_LENGTH,
} from '../document/template.js';

/*
 * Importar dados do ETP para o TR (US-037 · RN-TR-16..24 · api/09-term-of-reference.md TRM-05/06):
 * a prévia somente leitura (seções pelo `importMappings` da versão do template fixada no TR, campos
 * do cabeçalho e itens com a quantidade do ETP) com o `importToken` assinado de 15 min, e a
 * aplicação seletiva. Os mesmos schemas servem à API (corpo, resposta, OpenAPI) e ao painel
 * "Importar do ETP" da SCR-012.
 */

/** RN-TR-18: validade do `importToken`. */
export const TERM_IMPORT_TOKEN_TTL_MINUTES = 15;

/** Campos do cabeçalho do TR que a importação sabe preencher (`importMappings.fields[].target`). */
export const TERM_IMPORT_FIELDS = ['estimatedTotalValue', 'priceResearchId'] as const;
export type TermImportField = (typeof TERM_IMPORT_FIELDS)[number];

/** Mensagens da US-037 (Validações V-01..V-09, FA-02/04/05 e "Casos de erro"). */
export const TERM_IMPORT_MESSAGES = Object.freeze({
  noSelection: 'Selecione ao menos uma seção, campo ou os itens.',
  etpRequired: 'Este processo não tem um ETP para importar.',
  tokenInvalid: 'Gere a prévia novamente.',
  expired: 'O ETP ou o TR foram alterados. Atualizando a prévia…',
  confirmReplaceValueSource: 'Confirme a substituição do valor vinculado à pesquisa de preços.',
  priceResearchNeedsValue:
    'Importe também o valor estimado para trocar a pesquisa vinculada ao valor.',
  selectionInvalid: 'Revise a seleção.',
  sectionTooLong: (title: string) =>
    `O conteúdo importado excede o limite da seção "${title}". Desmarque-a ou ajuste o ETP.`,
  notEditable: 'O TR não pode ser editado no status atual.',
  typeNotAllowedInStage: 'O TR não pode ser editado nesta etapa do processo.',
  preconditionRequired: 'Atualize a página e tente novamente.',
  versionConflict: 'O TR foi alterado por outra pessoa. Recarregue para continuar.',
  permissionDenied: 'Você não tem permissão para editar este TR.',
  inProgress: 'Estamos concluindo a importação. Aguarde.',
  keyReused: 'Esta solicitação já foi enviada com outros dados.',
  unavailable: 'Não foi possível importar agora. Tente novamente em instantes.',
  etpInProgress: 'O ETP ainda não foi concluído; os dados podem mudar.',
  staleEtp: 'O ETP foi atualizado desde a última importação.',
  /** RN-TR-17: a referência à origem no `APPEND`. */
  appendedFrom: (versionNumber: number | null, date: string) =>
    versionNumber === null
      ? `Importado do ETP em ${date}`
      : `Importado do ETP v${String(versionNumber)} em ${date}`,
  applied: (sections: number, items: number) =>
    `Importação aplicada: ${String(sections)} ${sections === 1 ? 'seção' : 'seções'} e ${String(items)} ${items === 1 ? 'item atualizado' : 'itens atualizados'}`,
});

// --- TRM-05 — prévia ---------------------------------------------------------------------------

export const termImportSectionPreviewSchema = z
  .object({
    /** Chave da seção do TR (destino). */
    target: z.string(),
    /** Seções do ETP de origem, na ordem do mapeamento. */
    sources: z.array(z.string()),
    mode: z.enum(IMPORT_MAPPING_MODES),
    /** Texto atual da seção do TR ("antes"). */
    before: z.string(),
    /** Texto resultante da importação ("depois"). */
    preview: z.string(),
  })
  .meta({ id: 'TermImportSectionPreview' });
export type TermImportSectionPreviewDto = z.infer<typeof termImportSectionPreviewSchema>;

export const termImportFieldPreviewSchema = z
  .object({
    target: z.enum(TERM_IMPORT_FIELDS),
    source: z.string(),
    /** Valor de origem no ETP (decimal ou id); `null` quando mascarado (POL-09) ou vazio. */
    value: z.string().nullable(),
    valueMasked: z.boolean(),
    /** Valor atual do TR (mascarado como `value`). */
    current: z.string().nullable(),
  })
  .meta({ id: 'TermImportFieldPreview' });
export type TermImportFieldPreviewDto = z.infer<typeof termImportFieldPreviewSchema>;

export const termImportItemPreviewSchema = z
  .object({
    processItemId: z.uuid(),
    sequence: z.int(),
    description: z.string(),
    /** Decimal(18,4) como string. */
    etpQuantity: z.string(),
    /** `null` = o item ainda não está no TR (será incluído). */
    trCurrentQuantity: z.string().nullable(),
    /** FA-04: o item do TR já tem especificação/critérios — só muda com `overwriteExisting`. */
    specified: z.boolean(),
  })
  .meta({ id: 'TermImportItemPreview' });
export type TermImportItemPreviewDto = z.infer<typeof termImportItemPreviewSchema>;

export const termImportPreviewSchema = z
  .object({
    /** RN-TR-18: assinado, sem estado, válido por 15 min; consumido pelo TRM-06. */
    importToken: z.string(),
    expiresAt: isoDateTimeSchema,
    etp: z.object({
      id: z.uuid(),
      code: z.string().nullable(),
      status: z.enum(DOCUMENT_STATUSES),
      /** Versão vigente do ETP (`null` enquanto o ETP não tiver versão). */
      versionNumber: z.int().nullable(),
      /** FA-02: ETP em elaboração (`DRAFT`/`RETURNED`/`IN_REVIEW`) — os dados podem mudar. */
      inProgress: z.boolean(),
    }),
    sections: z.array(termImportSectionPreviewSchema),
    fields: z.array(termImportFieldPreviewSchema),
    items: z.object({
      count: z.int().min(0),
      copyQuantities: z.boolean(),
      copyCalculationMemoToNotes: z.boolean(),
      preview: z.array(termImportItemPreviewSchema),
    }),
    /** RN-TR-22: importar o valor troca a origem `PRICE_RESEARCH` — exige confirmação. */
    replacesPriceResearchValue: z.boolean(),
  })
  .meta({ id: 'TermImportPreview' });
export type TermImportPreviewDto = z.infer<typeof termImportPreviewSchema>;

// --- TRM-06 — aplicação ------------------------------------------------------------------------

export const termImportApplySchema = z
  .strictObject({
    /** V-03: emitido pelo TRM-05 para ESTE TR. */
    importToken: z
      .string({ error: TERM_IMPORT_MESSAGES.tokenInvalid })
      .min(1, { error: TERM_IMPORT_MESSAGES.tokenInvalid })
      .max(4096, { error: TERM_IMPORT_MESSAGES.tokenInvalid }),
    /** Seções do TR (destinos do mapeamento) a importar. */
    sections: z
      .array(z.string().trim().min(1).max(SECTION_KEY_MAX_LENGTH))
      .max(MAX_TEMPLATE_SECTIONS),
    fields: z.array(z.enum(TERM_IMPORT_FIELDS)).max(TERM_IMPORT_FIELDS.length),
    copyItems: z.boolean().default(true),
    /** FA-04 / RN-TR-21: só tem efeito com `copyItems`. */
    overwriteExisting: z.boolean().optional(),
    /** RN-TR-22: só depois do aviso. */
    confirmReplaceValueSource: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sections.length === 0 && value.fields.length === 0 && !value.copyItems) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: TERM_IMPORT_MESSAGES.noSelection,
        params: { code: 'REQUIRED' },
      });
    }
  })
  .meta({ id: 'TermImportApplyRequest' });
export type TermImportApply = z.infer<typeof termImportApplySchema>;
export type TermImportApplyInput = z.input<typeof termImportApplySchema>;

export const termImportResultSchema = z
  .object({
    term: termSchema,
    /** Seções do TR efetivamente gravadas, na ordem do mapeamento. */
    sectionsImported: z.array(z.string()),
    /** Campos do cabeçalho efetivamente gravados. */
    fieldsImported: z.array(z.enum(TERM_IMPORT_FIELDS)),
    /** Itens do ETP incluídos ou atualizados no TR. */
    itemsImported: z.int().min(0),
    /** A versão `IMPORT` criada. */
    documentVersion: z.object({ id: z.uuid(), versionNumber: z.int().min(1) }),
  })
  .meta({ id: 'TermImportResult' });
export type TermImportResultDto = z.infer<typeof termImportResultSchema>;

/** V-01: a seleção tem ao menos uma seção, um campo ou os itens. */
export function hasImportSelection(selection: {
  readonly sections: readonly string[];
  readonly fields: readonly string[];
  readonly copyItems: boolean;
}): boolean {
  return selection.sections.length > 0 || selection.fields.length > 0 || selection.copyItems;
}
