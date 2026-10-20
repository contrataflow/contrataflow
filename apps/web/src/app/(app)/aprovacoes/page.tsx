import { ApprovalListPage } from '@/features/approval-list/approval-list-page';

/**
 * SCR-014 — Aprovações (`/aprovacoes` · US-057): as aprovações da cobertura do usuário (APV-01),
 * lidas no cliente com filtros, ordenação e paginação; cada linha leva ao SCR-015.
 */
export default function ApprovalsRoutePage() {
  return <ApprovalListPage />;
}
