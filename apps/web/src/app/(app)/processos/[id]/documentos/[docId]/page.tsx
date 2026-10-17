import { DocumentView } from '@/features/documents/document-view';

/**
 * SCR-105 — Documento (`/processos/[id]/documentos/[docId]`): visualizador com o ciclo de vida da
 * US-065 (finalizar, submeter, reabrir, cancelar, excluir rascunho). O editor de seções chega com
 * a US-063.
 */
export default async function ProcessDocumentPage({
  params,
}: {
  readonly params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  return <DocumentView processId={id} documentId={docId} />;
}
