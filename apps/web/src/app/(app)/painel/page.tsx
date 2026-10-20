import { DashboardPage } from '@/features/dashboard/dashboard-page';

/**
 * SCR-003 — Painel (`/painel` · US-076): tela inicial após o login. Resumo (DSH-01) e um cartão por
 * indicador (DSH-02), lidos no cliente com polling de 60 s. Acesso por `DASHBOARD_VIEW`; sem a
 * permissão, o estado 403.
 */
export default function DashboardRoutePage() {
  return <DashboardPage />;
}
