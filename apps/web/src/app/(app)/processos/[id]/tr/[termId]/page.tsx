import { DocumentView } from '@/features/documents/document-view';
import { TermEditor } from '@/features/term/term-editor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SCR-012 — Termo de Referência (`/processos/[id]/tr/[termId]`): o id do TR é o do documento
 * (US-036). O visualizador do documento traz o cabeçalho e o ciclo de vida (status, versões, anexos,
 * comentários, prévia em PDF); o editor por seções entra no meio. A chegada depois de "Criar
 * Termo de Referência" põe o foco no título. US-120: o assistente de IA fica no editor (a
 * aplicação é adotada pelo autosave); `?ia=<generationId>` — link da notificação
 * `AI_GENERATION_READY` — abre o painel na geração.
 */
export default async function ProcessTermPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; termId: string }>;
  readonly searchParams?: Promise<{ ia?: string | string[] }>;
}) {
  const { id, termId } = await params;
  const ia = (await searchParams)?.ia;
  const aiGenerationId = typeof ia === 'string' && UUID.test(ia) ? ia : null;
  return (
    <DocumentView processId={id} documentId={termId} focusTitleOnLoad showAiAssistant={false}>
      <TermEditor processId={id} termId={termId} aiGenerationId={aiGenerationId} />
    </DocumentView>
  );
}
