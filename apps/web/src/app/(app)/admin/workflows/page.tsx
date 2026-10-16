import { WorkflowsView } from '@/features/workflows/workflows-view';

/**
 * SCR-034 — Administração › Workflows (US-042): lista com o selo "Padrão" e "Tornar padrão",
 * carregada no cliente com o `WF-01` (`WORKFLOW_VIEW`); a própria tela trata o 403 (RN-FND-92).
 * O editor (`/admin/workflows/[id]`) chega com a US-043.
 */
export default function WorkflowsPage() {
  return <WorkflowsView />;
}
