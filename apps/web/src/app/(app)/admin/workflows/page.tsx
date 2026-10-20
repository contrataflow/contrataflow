import { WorkflowsView } from '@/features/workflows/workflows-view';

/**
 * SCR-034 — Administração › Workflows (US-042/US-043): lista com o selo "Padrão", "Tornar padrão"
 * e "Novo workflow", carregada no cliente com o `WF-01` (`WORKFLOW_VIEW`); a própria tela trata o
 * 403 (RN-FND-92). Cada workflow abre o editor (`/admin/workflows/[id]`).
 */
export default function WorkflowsPage() {
  return <WorkflowsView />;
}
