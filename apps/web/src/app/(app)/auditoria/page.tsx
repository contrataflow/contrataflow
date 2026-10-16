import { AuditView } from '@/features/audit/audit-view';

/**
 * SCR-037 — Auditoria (`/auditoria` · US-074): aba "Selos" (lista de selos de integridade e
 * verificação de intervalo). Acesso por `AUDIT_VIEW`; a própria API decide cada requisição e a
 * tela esconde o conteúdo de quem não tem a permissão.
 */
export default function AuditPage() {
  return <AuditView />;
}
