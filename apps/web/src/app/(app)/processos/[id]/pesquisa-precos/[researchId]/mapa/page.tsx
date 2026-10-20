import { ComparativeMapView } from '@/features/price-research/comparative-map-view';

/**
 * SCR-010 — Mapa comparativo (`/processos/[id]/pesquisa-precos/[researchId]/mapa`): a matriz itens ×
 * fontes da pesquisa, com exportação em XLSX e PDF (US-031). Acesso por "Ver mapa comparativo" na
 * SCR-009.
 */
export default async function ComparativeMapPage({
  params,
}: {
  readonly params: Promise<{ id: string; researchId: string }>;
}) {
  const { id, researchId } = await params;
  return <ComparativeMapView processId={id} researchId={researchId} />;
}
