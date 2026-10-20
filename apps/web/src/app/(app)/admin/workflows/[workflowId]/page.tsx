import { WorkflowEditorView } from '@/features/workflows/workflow-editor';

/**
 * SCR-034 — editor do workflow (`/admin/workflows/[id]` · US-043): etapas, transições e "Criar
 * rascunho", carregados no cliente com WF-03/WF-09 (`WORKFLOW_VIEW`); a escrita exige
 * `WORKFLOW_MANAGE` e a API decide (RN-FND-92).
 */
export default async function WorkflowEditorPage({
  params,
}: {
  readonly params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <WorkflowEditorView workflowId={workflowId} />;
}
