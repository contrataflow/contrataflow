import { AuditView } from '@/features/audit/audit-view';

/**
 * SCR-037 — Auditoria (`/auditoria`): aba "Registros" (US-075 — consulta, detalhe e exportação da
 * trilha, padrão) e aba "Selos" (US-074 — selos de integridade e verificação de intervalo). Acesso
 * por `AUDIT_VIEW`; a própria API decide cada requisição e a tela esconde o conteúdo de quem não
 * tem a permissão.
 */
export default function AuditPage() {
  return <AuditView />;
}
