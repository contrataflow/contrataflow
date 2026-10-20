import { PriceResearchView } from '@/features/price-research/price-research-view';

/**
 * SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`): abas Itens,
 * Fontes e Documento (US-024). Acesso pelo painel do processo (SCR-006 — "Criar pesquisa de
 * preços", "Abrir pesquisa" e a aba Documentos).
 */
export default async function ProcessPriceResearchPage({
  params,
}: {
  readonly params: Promise<{ id: string; researchId: string }>;
}) {
  const { id, researchId } = await params;
  return <PriceResearchView processId={id} researchId={researchId} />;
}
