import { TEMPLATE_PREVIEW_MESSAGES, TEMPLATE_PREVIEW_TTL_HOURS } from '@contrataflow/validation';
import type {
  Confidentiality,
  DocumentKind,
  DocumentSnapshot,
  SectionDefinition,
  TemplatePreviewErrorCode,
  TemplatePreviewStatus,
} from '@contrataflow/validation';

import type { PdfFacts } from './pdf-inspection.js';

/*
 * Prévia efêmera do template (US-109 · RN-TPL-25..27 · TPL-09/12/13): o PDF de amostra do rascunho
 * (ou de uma versão publicada/aposentada — FA-01), sem `Document` nem `DocumentVersion` e sem linha
 * em `document_renditions` — o estado vive no Redis por 24 h e o PDF no bucket `renditions` com a
 * tag `ephemeral`. `PENDING → PROCESSING → READY | FAILED`; falha registra `errorCode` e mensagem
 * sanitizada e permite nova tentativa (FA-03). Funções puras.
 */

export interface TemplatePreview {
  readonly renditionId: string;
  readonly tenantId: string;
  readonly templateVersionId: string;
  /** `version` (ETag) da versão do template no pedido: nova edição exige nova prévia (RN-TPL-27). */
  readonly templateVersionRevision: number;
  readonly requestedById: string | null;
  readonly status: TemplatePreviewStatus;
  readonly storageKey: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  readonly errorCode: TemplatePreviewErrorCode | null;
  readonly errorMessage: string | null;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly readyAt: Date | null;
  readonly expiresAt: Date;
}

const HOUR_MS = 3_600_000;

export function requestTemplatePreview(input: {
  readonly renditionId: string;
  readonly tenantId: string;
  readonly templateVersionId: string;
  readonly templateVersionRevision: number;
  readonly requestedById: string | null;
  readonly now: Date;
}): TemplatePreview {
  return {
    renditionId: input.renditionId,
    tenantId: input.tenantId,
    templateVersionId: input.templateVersionId,
    templateVersionRevision: input.templateVersionRevision,
    requestedById: input.requestedById,
    status: 'PENDING',
    storageKey: null,
    sha256: null,
    sizeBytes: null,
    pageCount: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: input.now,
    startedAt: null,
    readyAt: null,
    expiresAt: new Date(input.now.getTime() + TEMPLATE_PREVIEW_TTL_HOURS * HOUR_MS),
  };
}

export function isPreviewInProgress(preview: TemplatePreview): boolean {
  return preview.status === 'PENDING' || preview.status === 'PROCESSING';
}

export function isPreviewExpired(preview: TemplatePreview, now: Date): boolean {
  return preview.expiresAt.getTime() <= now.getTime();
}

/** O worker assume a prévia pendente (`null` = já assumida ou concluída — nada a fazer). */
export function startPreview(preview: TemplatePreview, now: Date): TemplatePreview | null {
  if (preview.status !== 'PENDING') return null;
  return { ...preview, status: 'PROCESSING', startedAt: now };
}

export function previewReady(
  preview: TemplatePreview,
  pdf: PdfFacts & { readonly storageKey: string },
  now: Date,
): TemplatePreview {
  return {
    ...preview,
    status: 'READY',
    storageKey: pdf.storageKey,
    sha256: pdf.sha256,
    sizeBytes: pdf.sizeBytes,
    pageCount: pdf.pageCount,
    readyAt: now,
  };
}

export function previewFailed(
  preview: TemplatePreview,
  errorCode: TemplatePreviewErrorCode,
): TemplatePreview {
  return {
    ...preview,
    status: 'FAILED',
    storageKey: null,
    errorCode,
    errorMessage: TEMPLATE_PREVIEW_MESSAGES[errorCode],
  };
}

// --- Amostra do documento (RN-TPL-25) -----------------------------------------------------------

/** Texto do espaço reservado da seção sem conteúdo padrão. */
export const SECTION_PLACEHOLDER = 'Conteúdo da seção — texto de exemplo da prévia do template.';

/** Valores de exemplo de `process.*`/`document.*` (o tenant e o usuário são os reais). */
export const PREVIEW_SAMPLE = {
  processCode: 'PROC 0001/2026',
  processTitle: 'Processo de exemplo',
  processObject: 'Objeto de exemplo da contratação',
  requestingSecretariat: 'Secretaria de exemplo',
  requestingDepartment: 'Setor de exemplo',
  documentCode: 'DOC 0001/2026',
} as const;

const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';

function placeholder(): DocumentSnapshot['sections'][string]['content'] {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: SECTION_PLACEHOLDER }] }],
  };
}

export interface PreviewSnapshotInput {
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly templateName: string;
  readonly documentType: {
    readonly code: string;
    readonly kind: DocumentKind;
    readonly defaultConfidentiality: Confidentiality;
  };
  readonly versionNumber: number;
  readonly sections: readonly SectionDefinition[];
  readonly organizationName: string | null;
  readonly organizationCnpj: string | null;
  readonly now: Date;
}

/**
 * O `DocumentSnapshot` de amostra que o HTML do PDF consome (o mesmo de US-067): seções do template
 * com o `defaultContent` (ou o espaço reservado), sem cabeçalho tipado nem coleções.
 */
export function previewSnapshot(input: PreviewSnapshotInput): DocumentSnapshot {
  const sections: DocumentSnapshot['sections'] = {};
  for (const section of input.sections) {
    sections[section.key] = {
      state: 'FILLED',
      content: section.defaultContent ?? placeholder(),
      justification: null,
    };
  }
  return {
    schemaVersion: 1,
    document: {
      id: SAMPLE_ID,
      code: PREVIEW_SAMPLE.documentCode,
      title: `${input.templateName} (v${String(input.versionNumber)})`,
      typeCode: input.documentType.code,
      kind: input.documentType.kind,
      confidentiality: input.documentType.defaultConfidentiality,
      versionNumber: 1,
    },
    template: {
      templateId: input.templateId,
      versionId: input.templateVersionId,
      versionNumber: input.versionNumber,
    },
    process: {
      id: SAMPLE_ID,
      code: PREVIEW_SAMPLE.processCode,
      title: PREVIEW_SAMPLE.processTitle,
      object: PREVIEW_SAMPLE.processObject,
      organizationName: input.organizationName,
      organizationCnpj: input.organizationCnpj,
      requestingSecretariatName: PREVIEW_SAMPLE.requestingSecretariat,
      requestingDepartmentName: PREVIEW_SAMPLE.requestingDepartment,
      isBudgetConfidential: false,
    },
    header: {},
    sections,
    collections: {},
    generatedAt: input.now.toISOString(),
  };
}
