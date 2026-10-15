import { DocumentTypesView } from '@/features/document-types/document-types-view';

/**
 * SCR-108 — Administração › Tipos de documento (US-061). A lista é carregada no cliente com o
 * `DTY-01` (`includeInactive`): só quem tem `DOCUMENT_TYPE_MANAGE` recebe os dados, e a própria
 * tela trata o 403 (a API é quem decide — RN-FND-92).
 */
export default function DocumentTypesPage() {
  return <DocumentTypesView />;
}
