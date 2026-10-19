import { DocumentView } from '@/features/documents/document-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SCR-105 — Documento (`/processos/[id]/documentos/[docId]`): visualizador com o ciclo de vida da
 * US-065 (finalizar, submeter, reabrir, cancelar, excluir rascunho) e, no documento livre, o
 * editor de seções com autosave (US-063). `?ia=<generationId>` abre o assistente de IA (SCR-117) na geração — link da
 * notificação `AI_GENERATION_READY` (US-115).
 */
export default async function ProcessDocumentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; docId: string }>;
  readonly searchParams?: Promise<{ ia?: string | string[] }>;
}) {
  const { id, docId } = await params;
  const ia = (await searchParams)?.ia;
  const aiGenerationId = typeof ia === 'string' && UUID.test(ia) ? ia : null;
  return <DocumentView processId={id} documentId={docId} aiGenerationId={aiGenerationId} />;
}
