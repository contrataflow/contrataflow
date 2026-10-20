import { DfdWizard } from '@/features/dfd/dfd-wizard';

/**
 * SCR-007 — DFD em wizard (`/processos/[id]/dfd/[dfdId]?passo=…`): Identificação, Justificativa,
 * Planejamento, Revisão e Conclusão (US-014). Acesso pelo painel do processo (SCR-006 — "Elaborar
 * DFD" e a aba Documentos).
 */
export default async function ProcessDfdPage({
  params,
}: {
  readonly params: Promise<{ id: string; dfdId: string }>;
}) {
  const { id, dfdId } = await params;
  return <DfdWizard processId={id} dfdId={dfdId} />;
}
