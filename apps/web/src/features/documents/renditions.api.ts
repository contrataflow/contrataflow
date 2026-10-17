import type {
  DocumentRenditionDto,
  RenditionDownloadDto,
  RenditionStatus,
} from '@contrataflow/validation';
import { RENDITION_IN_PROGRESS_STATUSES } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * PDFs dos documentos (US-067 · SCR-105/106): DOC-20..23 de api/03-documents.md. O pedido responde
 * 202 com a rendition `PENDING` (o PDF nunca vem na resposta); a tela acompanha por DOC-22 até
 * `READY`/`FAILED` e baixa por DOC-23, que devolve uma URL pré-assinada de vida curta (≤ 300 s).
 * Chaves `['t', tenantId, 'document-renditions', id]` (RN-FND-90).
 */

export const renditionKeys = {
  /** DOC-22: `['t', tenantId, 'document-renditions', id]`. */
  detail: (tenantId: string, renditionId: string) =>
    tenantKey(tenantId, 'document-renditions', renditionId),
};

/** Intervalo curto do *polling* de DOC-22 enquanto o PDF está sendo gerado. */
export const RENDITION_POLL_MS = 2_000;

/** `true` enquanto o worker ainda não terminou (`PENDING`/`PROCESSING`). */
export function isRenditionInProgress(status: RenditionStatus | undefined): boolean {
  return status !== undefined && RENDITION_IN_PROGRESS_STATUSES.includes(status);
}

/**
 * Prévia vencida: o status `EXPIRED` ou o `expiresAt` já no passado (o job de expiração pode
 * demorar a virar o status). Só a prévia tem `expiresAt` (RN-DOC-68).
 */
export function isRenditionExpired(
  rendition: Pick<DocumentRenditionDto, 'status' | 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  if (rendition.status === 'EXPIRED') return true;
  return rendition.expiresAt !== null && Date.parse(rendition.expiresAt) <= now;
}

/** Resultado de DOC-20/DOC-21: `reused` quando a API devolveu a rendition que já existia (200). */
export interface RenditionRequestResult {
  readonly rendition: DocumentRenditionDto;
  readonly reused: boolean;
}

/** DOC-20: prévia do rascunho atual (sem corpo; cada pedido gera uma prévia nova). */
export async function requestDocumentPreview(documentId: string): Promise<RenditionRequestResult> {
  const result = await apiRequest<DocumentRenditionDto>(`/documents/${documentId}/preview`, {
    method: 'POST',
  });
  return { rendition: result.data, reused: false };
}

/** DOC-21: PDF oficial da versão (`CONTENT`); 200 = já existia e foi reaproveitado (FA-01). */
export async function requestVersionRendition(versionId: string): Promise<RenditionRequestResult> {
  const result = await apiRequest<DocumentRenditionDto>(
    `/document-versions/${versionId}/renditions`,
    { method: 'POST', body: { kind: 'CONTENT' } },
  );
  return { rendition: result.data, reused: result.status === 200 };
}

/** DOC-22 (*polling* do status). */
export async function fetchRendition(
  renditionId: string,
  signal?: AbortSignal,
): Promise<DocumentRenditionDto> {
  return (await apiRequest<DocumentRenditionDto>(`/document-renditions/${renditionId}`, { signal }))
    .data;
}

/** DOC-23: URL pré-assinada do PDF `READY` (validade ≤ 300 s; o navegador navega até ela). */
export async function fetchRenditionDownload(renditionId: string): Promise<RenditionDownloadDto> {
  return (await apiRequest<RenditionDownloadDto>(`/document-renditions/${renditionId}/download`))
    .data;
}

/**
 * Segue a URL pré-assinada (`Content-Disposition: attachment`: a página atual não é descarregada).
 * Só aceita http(s): qualquer outro esquema é recusado em vez de navegar.
 */
export function startDownload(url: string): void {
  const protocol = new URL(url).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('URL de download com esquema não permitido.');
  }
  window.location.assign(url);
}
