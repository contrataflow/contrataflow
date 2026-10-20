import { DocumentView } from '@/features/documents/document-view';
import { EtpEditor } from '@/features/etp/etp-editor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SCR-008 — ETP (`/processos/[id]/etp/[etpId]`): o id do ETP é o do documento (US-019). O
 * visualizador do documento traz o cabeçalho e o ciclo de vida (status, versões, anexos,
 * comentários); o editor por seções (US-020) entra no meio. A chegada depois de "Criar ETP" põe o
 * foco no título. US-118: o assistente de IA fica no editor (a aplicação recarrega as seções);
 * `?ia=<generationId>` — link da notificação `AI_GENERATION_READY` — abre o painel na geração.
 */
export default async function ProcessEtpPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; etpId: string }>;
  readonly searchParams?: Promise<{ ia?: string | string[] }>;
}) {
  const { id, etpId } = await params;
  const ia = (await searchParams)?.ia;
  const aiGenerationId = typeof ia === 'string' && UUID.test(ia) ? ia : null;
  return (
    <DocumentView processId={id} documentId={etpId} focusTitleOnLoad showAiAssistant={false}>
      <EtpEditor processId={id} etpId={etpId} aiGenerationId={aiGenerationId} />
    </DocumentView>
  );
}
