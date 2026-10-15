import { TemplatesView } from '@/features/templates/templates-view';

/**
 * SCR-033 — Administração › Templates (US-107). A lista é carregada no cliente com o `TPL-01`
 * (`TEMPLATE_VIEW`); a própria tela trata o 403 (a API é quem decide — RN-FND-92).
 */
export default function TemplatesPage() {
  return <TemplatesView />;
}
