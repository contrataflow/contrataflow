import type { DocumentPresenceDto, DocumentPresenceEditorDto } from '@contrataflow/validation';

import { apiRequest, apiUrl } from '@/lib/api/client';

/*
 * Indicador de edição concorrente (US-070 · DOC-24/25 de api/03-documents.md). O heartbeat é uma
 * sondagem de escrita (não renova a ociosidade da sessão nem abre o banner de indisponibilidade); a
 * saída usa `fetch` com `keepalive` para sobreviver ao fechamento da aba (melhor esforço — o
 * `sendBeacon` só faz POST e o TTL de 60 s cobre o que se perder).
 */

/** DOC-24: renova a presença e devolve os DEMAIS editores ativos. */
export async function sendPresenceHeartbeat(
  documentId: string,
  sectionKey: string | undefined,
  signal?: AbortSignal,
): Promise<readonly DocumentPresenceEditorDto[]> {
  const result = await apiRequest<DocumentPresenceDto>(`/documents/${documentId}/presence`, {
    method: 'PUT',
    body: sectionKey === undefined ? {} : { sectionKey },
    signal,
  });
  return result.data.editors;
}

/** DOC-25 (melhor esforço): nunca lança, sobrevive ao `pagehide`. */
export function leaveDocumentPresence(documentId: string, fetchImpl: typeof fetch = fetch): void {
  try {
    void fetchImpl(apiUrl(`/documents/${documentId}/presence`), {
      method: 'DELETE',
      headers: { 'X-CF-Request': '1' },
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Sem rede ou ambiente sem `fetch`: o TTL de 60 s expira a presença.
  }
}
