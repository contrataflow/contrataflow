import { DocumentView } from '@/features/documents/document-view';
import { TermEditor } from '@/features/term/term-editor';

/**
 * SCR-012 — Termo de Referência (`/processos/[id]/tr/[termId]`): o id do TR é o do documento
 * (US-036). O visualizador do documento traz o cabeçalho e o ciclo de vida (status, versões, anexos,
 * comentários, prévia em PDF); o editor por seções entra no meio. A chegada depois de "Criar
 * Termo de Referência" põe o foco no título.
 */
export default async function ProcessTermPage({
  params,
}: {
  readonly params: Promise<{ id: string; termId: string }>;
}) {
  const { id, termId } = await params;
  return (
    <DocumentView processId={id} documentId={termId} focusTitleOnLoad>
      <TermEditor processId={id} termId={termId} />
    </DocumentView>
  );
}
