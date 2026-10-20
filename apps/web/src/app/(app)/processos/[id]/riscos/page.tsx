import { RisksScreen } from '@/features/risks/risks-screen';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SCR-011 — Riscos (`/processos/[id]/riscos`): registro e avaliação de riscos do processo por
 * probabilidade × impacto (US-033). Acesso a partir do painel do processo (SCR-006).
 * `?ia=<generationId>` abre o assistente de IA (SCR-117) na proposta de riscos — link da
 * notificação `AI_GENERATION_READY` (US-119).
 */
export default async function ProcessRisksPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<{ ia?: string | string[] }>;
}) {
  const { id } = await params;
  const ia = (await searchParams)?.ia;
  const aiGenerationId = typeof ia === 'string' && UUID.test(ia) ? ia : null;
  return <RisksScreen processId={id} aiGenerationId={aiGenerationId} />;
}
