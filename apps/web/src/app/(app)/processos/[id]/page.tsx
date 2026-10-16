import { ProcessPanel } from '@/features/processes/process-panel';

/**
 * SCR-006 — Detalhe do processo (`/processos/[id]`): painel situacional mínimo da US-001 (onde
 * está, próximo passo e ações disponíveis); as abas chegam com a US-004.
 */
export default async function ProcessDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProcessPanel processId={id} />;
}
