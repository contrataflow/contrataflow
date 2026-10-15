import { StructureView } from '@/features/organizations/structure-view';

/**
 * SCR-032 — Administração › Estrutura (US-101: aba "Órgãos"). A lista é carregada no cliente com o
 * `ORG-01` (leitura é capacidade implícita do vínculo ativo); as ações de escrita dependem de
 * `ORGANIZATION_MANAGE`, e é a API quem decide (RN-FND-92).
 */
export default function StructurePage() {
  return <StructureView />;
}
