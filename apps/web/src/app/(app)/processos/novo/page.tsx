import { NewProcessPage } from '@/features/processes/new-process-page';

/**
 * SCR-005 — Novo processo (US-001): wizard de três passos em `/processos/novo`. Exige
 * `PROCESS_CREATE`; sem ela a própria tela mostra o 403 do SCR-111 (RN-FND-92).
 */
export default function NewProcessRoutePage() {
  return <NewProcessPage />;
}
