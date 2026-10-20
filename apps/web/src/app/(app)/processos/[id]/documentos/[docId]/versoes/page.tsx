import { DocumentVersionsView } from '@/features/documents/document-versions-view';

/**
 * SCR-106 — Versões e comparação (`/processos/[id]/documentos/[docId]/versoes`): lista das versões
 * imutáveis do documento, "Salvar versão" e a comparação de duas versões quaisquer (US-066). A
 * geração de PDF de uma versão chega com a US-067.
 */
export default async function DocumentVersionsPage({
  params,
}: {
  readonly params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  return <DocumentVersionsView processId={id} documentId={docId} />;
}
