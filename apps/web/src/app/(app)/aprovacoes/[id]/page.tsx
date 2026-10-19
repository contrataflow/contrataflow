import { ApprovalDetail } from '@/features/approval-decision/approval-detail';

/**
 * SCR-015 — Detalhe da aprovação (`/aprovacoes/[id]`): documentos cobertos e painel de decisão
 * (aprovar, devolver para ajuste ou indeferir) da US-052.
 */
export default async function ApprovalDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApprovalDetail approvalId={id} />;
}
