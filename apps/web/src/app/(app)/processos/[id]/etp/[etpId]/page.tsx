import { DocumentView } from '@/features/documents/document-view';

/**
 * SCR-008 — ETP (`/processos/[id]/etp/[etpId]`): o id do ETP é o do documento (US-019). Até o
 * editor por seções (US-020) chegar, a tela é o visualizador do documento com o ciclo de vida
 * (cabeçalho, status, versões); a chegada depois de "Criar ETP" põe o foco no título.
 */
export default async function ProcessEtpPage({
  params,
}: {
  readonly params: Promise<{ id: string; etpId: string }>;
}) {
  const { id, etpId } = await params;
  return <DocumentView processId={id} documentId={etpId} focusTitleOnLoad />;
}
