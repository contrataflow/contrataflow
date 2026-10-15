import { StructureView } from '@/features/organizations/structure-view';

/**
 * SCR-032 — Administração › Estrutura: abas "Órgãos" (US-101 · ORG-01) e "Secretarias" (US-102 ·
 * DEP-01). Os dados são carregados no cliente (leitura é capacidade implícita do vínculo ativo); as
 * ações de escrita dependem de `ORGANIZATION_MANAGE`/`DEPARTMENT_MANAGE`, e é a API quem decide
 * (RN-FND-92).
 */
export default function StructurePage() {
  return <StructureView />;
}
