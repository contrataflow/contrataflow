import { SuppliersView } from '@/features/suppliers/suppliers-view';

/**
 * SCR-107 — Fornecedores (`/fornecedores` · US-025): cadastro de fornecedores do tenant, usado nas
 * pesquisas de preços (US-026). A lista é carregada no cliente; a própria API decide o acesso
 * (`SUPPLIER_VIEW` — RN-FND-92) e a tela trata o 403. O cabeçalho (com "Novo fornecedor") vem da
 * própria lista, no modelo `ListPage` (prd-5).
 */
export default function SuppliersPage() {
  return <SuppliersView />;
}
