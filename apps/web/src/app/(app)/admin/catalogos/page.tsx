import { CatalogsView } from '@/features/catalogs/catalogs-view';

/**
 * SCR-109 — Administração › Catálogos (US-104). Os itens são lidos no cliente com o `CAT-01`
 * (leitura é capacidade implícita do vínculo ativo); as ações de escrita dependem de
 * `CATALOG_MANAGE`, e é a API quem decide (RN-FND-92).
 */
export default function CatalogsPage() {
  return <CatalogsView />;
}
