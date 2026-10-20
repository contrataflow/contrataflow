import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';

/*
 * PDFs dos documentos (US-067 · DEC-060 · ADR-007 · api/03-documents.md DOC-20..23): a prévia do
 * rascunho, o PDF oficial de uma versão e o selo de aprovação. Schemas compartilhados pela API
 * (corpo, resposta, OpenAPI) e pela SCR-105/106 (`GeneratePdfButton`, `RenditionStatusBadge`).
 */

/** `RenditionKind` (entities.md §2): `SIGNED` fica reservado ao MVP 3 (RN-DOC-63). */
export const RENDITION_KINDS = ['PREVIEW', 'CONTENT', 'APPROVAL_STAMPED', 'SIGNED'] as const;
export type RenditionKind = (typeof RENDITION_KINDS)[number];

/** `RenditionStatus` (entities.md §2): `PENDING → PROCESSING → READY | FAILED`, `EXPIRED` (prévia). */
export const RENDITION_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type RenditionStatus = (typeof RENDITION_STATUSES)[number];

/** Estados em que o PDF ainda está sendo gerado (o front segue consultando — *polling*). */
export const RENDITION_IN_PROGRESS_STATUSES: readonly RenditionStatus[] = ['PENDING', 'PROCESSING'];

export const RENDITION_LIMITS = {
  /** RN-DOC-68: validade da prévia. */
  previewTtlHours: 24,
  /** RN-DOC-69 · DEC-136: validade máxima da URL de download. */
  downloadUrlSeconds: 300,
} as const;

export const RENDITION_MESSAGES = {
  notReady: 'O PDF ainda está sendo gerado. Aguarde.',
  previewExpired: 'Esta prévia expirou. Gere novamente.',
  noVersion: 'Não há versão para gerar este PDF.',
  failed: 'Não foi possível gerar o PDF. A equipe foi notificada.',
  notFound: 'Documento ou versão não encontrados.',
  approvalRequired: 'Informe a aprovação do selo.',
  approvalNotAllowed: 'A aprovação só se aplica ao PDF com selo de aprovação.',
  rateLimited: 'Muitas solicitações de PDF. Aguarde alguns segundos.',
  unavailable: 'Não foi possível processar sua solicitação agora.',
  confidential: 'Este PDF contém valores sigilosos que você não pode ver.',
} as const;

// --- Requisições --------------------------------------------------------------------------------

/** DOC-21 (corpo): `approvalId` obrigatório só no selo de aprovação (FA-02). */
export const renditionRequestSchema = z
  .strictObject({
    kind: z.enum(['CONTENT', 'APPROVAL_STAMPED']),
    approvalId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'APPROVAL_STAMPED' && value.approvalId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvalId'],
        message: RENDITION_MESSAGES.approvalRequired,
        params: { code: 'REQUIRED' },
      });
    }
    if (value.kind === 'CONTENT' && value.approvalId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvalId'],
        message: RENDITION_MESSAGES.approvalNotAllowed,
        params: { code: 'NOT_ALLOWED' },
      });
    }
  });
export type RenditionRequest = z.infer<typeof renditionRequestSchema>;

/** DOC-22/23 (path). */
export const renditionIdParamsSchema = z.strictObject({ renditionId: uuidV7Schema });

// --- Respostas ----------------------------------------------------------------------------------

/** `DocumentRendition` (DOC-20..22): sem `storageKey` nem a mensagem técnica do erro. */
export const documentRenditionSchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    documentVersionId: z.uuid().nullable(),
    draftRevision: z.int().nullable(),
    approvalId: z.uuid().nullable(),
    kind: z.enum(RENDITION_KINDS),
    status: z.enum(RENDITION_STATUSES),
    /** POL-09: gerado com os valores sigilosos ocultos (quem pediu não podia vê-los). */
    masked: z.boolean(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    sizeBytes: z.int().nullable(),
    pageCount: z.int().nullable(),
    errorCode: z.string().nullable(),
    attempts: z.int(),
    requestedById: z.uuid().nullable(),
    requestedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    readyAt: isoDateTimeSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'DocumentRendition' });
export type DocumentRenditionDto = z.infer<typeof documentRenditionSchema>;

/** DOC-23: URL pré-assinada (≤ 300 s, `Content-Disposition: attachment`). */
export const renditionDownloadSchema = z
  .object({ url: z.url(), expiresAt: isoDateTimeSchema })
  .meta({ id: 'RenditionDownload' });
export type RenditionDownloadDto = z.infer<typeof renditionDownloadSchema>;
