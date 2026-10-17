import { RisksScreen } from '@/features/risks/risks-screen';

/**
 * SCR-011 — Riscos (`/processos/[id]/riscos`): registro e avaliação de riscos do processo por
 * probabilidade × impacto (US-033). Acesso a partir do painel do processo (SCR-006).
 */
export default async function ProcessRisksPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RisksScreen processId={id} />;
}
