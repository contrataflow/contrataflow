import type { AttachmentTargetType } from '@contrataflow/types';
import type {
  AttachmentConfirmationDto,
  AttachmentDownloadDto,
  AttachmentDto,
  AttachmentUploadDto,
  CreateAttachmentIntent,
  PageMeta,
} from '@contrataflow/validation';
import { attachmentUploadSchema } from '@contrataflow/validation';

import { apiRequest, newIdempotencyKey } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Upload seguro de anexos (US-068 · DEC-136 · api/12-comments-attachments.md): intenção (ATT-02,
 * pelo BFF), PUT DIRETO no bucket de quarentena pela URL pré-assinada (nunca pelo BFF — a origem do
 * S3 está no `connect-src` da CSP), confirmação (ATT-03) e consulta do status (ATT-04) até o fim da
 * varredura. Exclusão: ATT-06 com `If-Match` e motivo.
 */

export interface AttachmentIntent {
  readonly attachment: AttachmentDto;
  readonly upload: AttachmentUploadDto;
}

/** ATT-02: `{ data, upload }` — as instruções do PUT vêm como membro irmão de `data`. */
export async function createAttachmentIntent(
  body: CreateAttachmentIntent,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<AttachmentIntent> {
  const result = await apiRequest<AttachmentDto>('/attachments', {
    method: 'POST',
    body,
    idempotencyKey,
  });
  const upload = attachmentUploadSchema.safeParse(result.members?.upload);
  if (!upload.success) throw new Error('Resposta de ATT-02 sem instruções de upload.');
  return { attachment: result.data, upload: upload.data };
}

/**
 * PUT direto na quarentena com os cabeçalhos assinados; `onProgress` recebe 0–100. `XMLHttpRequest`
 * porque o `fetch` não expõe o progresso do envio.
 */
export function uploadToStorage(
  upload: AttachmentUploadDto,
  file: Blob,
  onProgress: (percent: number) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = createRequest();
    request.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload recusado pelo armazenamento (${String(request.status)}).`));
    };
    request.onerror = () => {
      reject(new Error('Falha de rede no upload.'));
    };
    request.send(file);
  });
}

/** ATT-03. */
export async function confirmAttachment(
  attachmentId: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<AttachmentConfirmationDto> {
  return (
    await apiRequest<AttachmentConfirmationDto>(`/attachments/${attachmentId}/confirm`, {
      method: 'POST',
      idempotencyKey,
    })
  ).data;
}

/** ATT-04 (*polling* do status da varredura). */
export async function fetchAttachment(
  attachmentId: string,
  signal?: AbortSignal,
): Promise<AttachmentDto> {
  return (await apiRequest<AttachmentDto>(`/attachments/${attachmentId}`, { signal })).data;
}

/** ATT-06: exclusão lógica com motivo e a versão lida (`If-Match`). */
export async function deleteAttachment(
  attachment: Pick<AttachmentDto, 'id' | 'version'>,
  deletionReason: string,
): Promise<void> {
  await apiRequest<null>(`/attachments/${attachment.id}`, {
    method: 'DELETE',
    body: { deletionReason },
    ifMatch: `"${String(attachment.version)}"`,
  });
}

/**
 * ATT-05: URL assinada (≤ 300 s) do anexo `AVAILABLE`, auditada pela API a cada pedido — nunca
 * guardar em cache além da validade. A prévia inline busca os bytes por `fetch` (US-064 · RN-DOC-36).
 */
export async function fetchAttachmentDownload(
  attachmentId: string,
  signal?: AbortSignal,
): Promise<AttachmentDownloadDto> {
  return (
    await apiRequest<AttachmentDownloadDto>(`/attachments/${attachmentId}/download`, { signal })
  ).data;
}

/** Anexos do processo (US-069): `['t', tenantId, 'attachments', processId, …]`. */
export const attachmentKeys = {
  process: (tenantId: string, processId: string) => tenantKey(tenantId, 'attachments', processId),
  list: (tenantId: string, processId: string, targetType?: string, targetId?: string) =>
    tenantKey(tenantId, 'attachments', processId, 'list', targetType ?? 'all', targetId ?? 'all'),
};

export interface AttachmentPage {
  readonly items: readonly AttachmentDto[];
  readonly meta: PageMeta;
}

export interface AttachmentListFilter {
  readonly targetType?: AttachmentTargetType | undefined;
  readonly targetId?: string | undefined;
}

/** ATT-01: anexos do processo, filtráveis pelo alvo (até 100 por página, `-createdAt`). */
export async function fetchProcessAttachments(
  processId: string,
  filter: AttachmentListFilter = {},
  signal?: AbortSignal,
): Promise<AttachmentPage> {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  if (filter.targetType !== undefined) query.set('targetType', filter.targetType);
  if (filter.targetId !== undefined && filter.targetType !== undefined) {
    query.set('targetId', filter.targetId);
  }
  const result = await apiRequest<AttachmentDto[]>(
    `/processes/${processId}/attachments?${query.toString()}`,
    { signal },
  );
  return { items: result.data, meta: result.meta as unknown as PageMeta };
}

/**
 * Entrega do download (ATT-05): navega até a URL assinada (`Content-Disposition: attachment`). Só
 * aceita http(s): qualquer outro esquema é recusado em vez de navegar.
 */
export function startAttachmentDownload(url: string): void {
  const protocol = new URL(url).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('URL de download com esquema não permitido.');
  }
  window.location.assign(url);
}
