import { ProcessPanel } from '@/features/process-panel/process-panel';

/**
 * SCR-006 — Detalhe do processo (`/processos/[id]?aba=…`): painel situacional da US-004
 * (cabeçalho, barra de ações, stepper, as 7 perguntas e as abas).
 */
export default async function ProcessDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProcessPanel processId={id} />;
}
