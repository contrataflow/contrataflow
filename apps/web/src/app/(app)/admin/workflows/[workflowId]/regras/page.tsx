import { WorkflowRulesView } from '@/features/workflows/workflow-rules';

/**
 * SCR-035 — regras de etapa e de transição (`/admin/workflows/[id]/regras` · US-044): carregadas no
 * cliente com WF-03/WF-09/WF-19 (`WORKFLOW_VIEW`); criar, editar, excluir, reordenar e testar exigem
 * `WORKFLOW_MANAGE` e a API decide (RN-FND-92).
 */
export default async function WorkflowRulesPage({
  params,
}: {
  readonly params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <WorkflowRulesView workflowId={workflowId} />;
}
