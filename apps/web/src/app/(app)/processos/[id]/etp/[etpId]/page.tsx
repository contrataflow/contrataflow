import { DocumentView } from '@/features/documents/document-view';
import { EtpEditor } from '@/features/etp/etp-editor';

/**
 * SCR-008 — ETP (`/processos/[id]/etp/[etpId]`): o id do ETP é o do documento (US-019). O
 * visualizador do documento traz o cabeçalho e o ciclo de vida (status, versões, anexos,
 * comentários); o editor por seções (US-020) entra no meio. A chegada depois de "Criar ETP" põe o
 * foco no título.
 */
export default async function ProcessEtpPage({
  params,
}: {
  readonly params: Promise<{ id: string; etpId: string }>;
}) {
  const { id, etpId } = await params;
  return (
    <DocumentView processId={id} documentId={etpId} focusTitleOnLoad>
      <EtpEditor processId={id} etpId={etpId} />
    </DocumentView>
  );
}
