import { PCA_STATUSES, richTextFromPlainText } from '@contrataflow/validation';
import type {
  DocumentSnapshot,
  EtpConclusion,
  EtpEstimatedValueSource,
  ParcelingDecision,
  PcaStatus,
  RichTextDocValue,
} from '@contrataflow/validation';
import { z } from 'zod';

/*
 * ETP (US-019 · entities.md §4.8 `Etp` · RN-ETP-01..06): o cabeçalho tipado 1:1 do `Document` do
 * tipo `ETP` (mesmo id) e o plano da importação do DFD — funções puras sobre o snapshot da versão
 * de origem (RN-ETP-04), sem acoplar o `etp` ao módulo `dfd`: o objeto e a justificativa vão para
 * `NEED_DESCRIPTION`, a situação no PCA para `PCA_ALIGNMENT` e cada item vira uma linha do ETP com
 * o mesmo `processItemId` e a mesma `quantity` (DEC-019 — nunca um `ProcessItem` novo).
 */

export interface Etp {
  /** = `documentId` (CHECK `etps_id_is_document`). */
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string;
  readonly recommendedAlternativeId: string | null;
  readonly parcelingDecision: ParcelingDecision | null;
  readonly conclusion: EtpConclusion;
  /** Decimal(18,2) como string. */
  readonly estimatedTotalValue: string | null;
  readonly estimatedValueSource: EtpEstimatedValueSource | null;
  readonly priceResearchId: string | null;
  readonly importedFromDfdVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Fábrica do cabeçalho na criação (RN-ETP-01/05): `conclusion = PENDING`, versão 1. */
export function createEtp(input: {
  readonly documentId: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly importedFromDfdVersionId: string | null;
  readonly creatorId: string | null;
  readonly now: Date;
}): Etp {
  return {
    id: input.documentId,
    tenantId: input.tenantId,
    processId: input.processId,
    documentId: input.documentId,
    recommendedAlternativeId: null,
    parcelingDecision: null,
    conclusion: 'PENDING',
    estimatedTotalValue: null,
    estimatedValueSource: null,
    priceResearchId: null,
    importedFromDfdVersionId: input.importedFromDfdVersionId,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.creatorId,
    updatedById: input.creatorId,
    version: 1,
  };
}

// --- Estimativas (US-022 · RN-ETP-28/29/31) -----------------------------------------------------

/**
 * Origem e valor estimado pedidos no ETP-04 (RN-ETP-28): manual (≥ 0, 2 casas) ou vinculado à
 * pesquisa de preços — o valor é a CÓPIA do total da pesquisa (`null` enquanto ela não tem cálculo —
 * FA-03), somente leitura daí em diante e sincronizado pelo worker (RN-ETP-29).
 */
export type EtpEstimate =
  | { readonly source: 'MANUAL'; readonly value: string }
  | {
      readonly source: 'PRICE_RESEARCH';
      readonly priceResearchId: string;
      /** Decimal(18,2) como string; `null` = pesquisa ainda sem cálculo. */
      readonly value: string | null;
    };

export type EtpEstimateField = 'estimatedValueSource' | 'estimatedTotalValue' | 'priceResearchId';

export interface EtpEstimateChange {
  readonly field: EtpEstimateField;
  readonly old: string | null;
  readonly new: string | null;
}

/**
 * `Etp.setEstimate` (RN-ETP-28): FA-01 (manual → pesquisa: o manual é descartado pelo total da
 * pesquisa) e FA-02 (pesquisa → manual: o valor enviado — a tela parte do último copiado). Devolve
 * o ETP com `version + 1` e os campos alterados; nada mudou = o mesmo ETP e `changes` vazio.
 */
export function setEtpEstimate(
  etp: Etp,
  estimate: EtpEstimate,
  options: { readonly actorId: string | null; readonly now: Date },
): { readonly etp: Etp; readonly changes: EtpEstimateChange[] } {
  const next = {
    estimatedValueSource: estimate.source,
    estimatedTotalValue: estimate.value,
    priceResearchId: estimate.source === 'PRICE_RESEARCH' ? estimate.priceResearchId : null,
  } as const;
  const changes: EtpEstimateChange[] = [];
  for (const field of ['estimatedValueSource', 'estimatedTotalValue', 'priceResearchId'] as const) {
    if (etp[field] !== next[field]) changes.push({ field, old: etp[field], new: next[field] });
  }
  if (changes.length === 0) return { etp, changes };
  return {
    etp: {
      ...etp,
      ...next,
      updatedAt: options.now,
      updatedById: options.actorId,
      version: etp.version + 1,
    },
    changes,
  };
}

// --- Importação do DFD (RN-ETP-05/06) -----------------------------------------------------------

/** Seções do ETP preenchidas pela importação. */
export const IMPORTED_SECTION_KEYS = ['NEED_DESCRIPTION', 'PCA_ALIGNMENT'] as const;
export type ImportedSectionKey = (typeof IMPORTED_SECTION_KEYS)[number];

/** Linha de item importada: o item canônico do processo e a quantidade do DFD (RN-ETP-06). */
export interface ImportedEtpItem {
  readonly processItemId: string;
  /** Decimal(18,4) como string. */
  readonly quantity: string;
}

export interface DfdImportPlan {
  readonly sections: Partial<Record<ImportedSectionKey, RichTextDocValue>>;
  readonly items: readonly ImportedEtpItem[];
}

/** O que o ETP lê do cabeçalho do DFD no snapshot (`header` — `dfdHeaderValues`). */
const dfdHeaderSchema = z.looseObject({
  objectSummary: z.string().nullish(),
  pcaStatus: z.enum(PCA_STATUSES).nullish(),
  pcaYear: z.int().nullish(),
  pcaItemCode: z.string().nullish(),
  pcaJustification: z.string().nullish(),
});

/** Itens do DFD no snapshot (`collections.items` — `DfdDocumentValidator.snapshotParts`). */
const dfdItemsSchema = z.array(
  z.looseObject({
    processItemId: z.uuid(),
    quantity: z.union([z.string(), z.number()]),
    sortOrder: z.int().optional(),
  }),
);

type RichNode = Readonly<Record<string, unknown>>;

/** Texto do alinhamento ao PCA a partir da situação no DFD (RN-ETP-05). */
export function pcaAlignmentText(pca: {
  readonly pcaStatus: PcaStatus;
  readonly pcaYear?: number | null | undefined;
  readonly pcaItemCode?: string | null | undefined;
  readonly pcaJustification?: string | null | undefined;
}): string {
  switch (pca.pcaStatus) {
    case 'PLANNED': {
      const year =
        pca.pcaYear === null || pca.pcaYear === undefined ? '' : ` de ${String(pca.pcaYear)}`;
      const item = (pca.pcaItemCode ?? '').trim() === '' ? '' : `, item ${pca.pcaItemCode ?? ''}`;
      return `A contratação está prevista no Plano de Contratações Anual${year}${item}.`;
    }
    case 'NOT_PLANNED': {
      const justification = (pca.pcaJustification ?? '').trim();
      return justification === ''
        ? 'A contratação não está prevista no Plano de Contratações Anual.'
        : `A contratação não está prevista no Plano de Contratações Anual. Justificativa: ${justification}`;
    }
    case 'NOT_APPLICABLE':
      return 'A contratação não se sujeita ao Plano de Contratações Anual (não se aplica).';
  }
}

/** Objeto do DFD em um parágrafo, seguido dos blocos da justificativa (`JUSTIFICATION`). */
function needDescription(
  objectSummary: string,
  justification: DocumentSnapshot['sections'][string] | undefined,
): RichTextDocValue {
  const object = richTextFromPlainText(objectSummary.trim());
  const blocks = (justification?.content as { content?: readonly RichNode[] } | null | undefined)
    ?.content;
  return {
    type: 'doc',
    content: [...(object.content ?? []), ...(blocks ?? [])],
  };
}

/** Quantidade como Decimal(18,4) em string (o snapshot guarda a string do repositório). */
function asQuantity(value: string | number): string {
  return typeof value === 'number' ? value.toFixed(4) : value;
}

/**
 * Plano da importação a partir do snapshot da versão do DFD (RN-ETP-05/06): seções e itens. Campos
 * ausentes no snapshot não geram a seção correspondente; itens repetidos contam uma vez (o ETP tem
 * uma linha por item do processo — `document_items_document_process_item_key`).
 */
export function planDfdImport(
  snapshot: Pick<DocumentSnapshot, 'header' | 'sections' | 'collections'>,
): DfdImportPlan {
  const header = dfdHeaderSchema.safeParse(snapshot.header);
  const values = header.success ? header.data : {};
  const sections: Partial<Record<ImportedSectionKey, RichTextDocValue>> = {};
  const objectSummary = values.objectSummary ?? '';
  const justification = snapshot.sections.JUSTIFICATION;
  if (objectSummary.trim() !== '' || justification?.content) {
    sections.NEED_DESCRIPTION = needDescription(objectSummary, justification);
  }
  if (values.pcaStatus !== null && values.pcaStatus !== undefined) {
    sections.PCA_ALIGNMENT = richTextFromPlainText(
      pcaAlignmentText({
        pcaStatus: values.pcaStatus,
        pcaYear: values.pcaYear,
        pcaItemCode: values.pcaItemCode,
        pcaJustification: values.pcaJustification,
      }),
    );
  }
  const parsed = dfdItemsSchema.safeParse(snapshot.collections.items ?? []);
  const rows = parsed.success ? [...parsed.data] : [];
  rows.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const seen = new Set<string>();
  const items: ImportedEtpItem[] = [];
  for (const row of rows) {
    if (seen.has(row.processItemId)) continue;
    seen.add(row.processItemId);
    items.push({ processItemId: row.processItemId, quantity: asQuantity(row.quantity) });
  }
  return { sections, items };
}

/** Resumo do DFD para o cartão "Importar dados do DFD" (passo 2 da US-019). */
export function dfdImportPreview(snapshot: Pick<DocumentSnapshot, 'header' | 'collections'>): {
  readonly objectSummary: string;
  readonly pcaStatus: PcaStatus | null;
  readonly itemsCount: number;
} {
  const header = dfdHeaderSchema.safeParse(snapshot.header);
  const items = dfdItemsSchema.safeParse(snapshot.collections.items ?? []);
  return {
    objectSummary: header.success ? (header.data.objectSummary ?? '') : '',
    pcaStatus: header.success ? (header.data.pcaStatus ?? null) : null,
    itemsCount: items.success ? new Set(items.data.map((item) => item.processItemId)).size : 0,
  };
}
