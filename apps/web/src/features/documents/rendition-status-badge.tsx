import type { RenditionStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

const TONES: Record<RenditionStatus, string> = {
  PENDING: 'bg-primary-soft text-foreground',
  PROCESSING: 'bg-primary-soft text-foreground',
  READY: 'bg-success-soft text-foreground',
  FAILED: 'bg-destructive-soft text-foreground',
  EXPIRED: 'bg-muted text-muted-foreground',
};

const BASE =
  'inline-flex items-center rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap';

/**
 * Situação do PDF (US-067): "Gerando PDF…" (`PENDING`/`PROCESSING`), "PDF pronto", "Falha ao
 * gerar" e "Prévia expirada". O texto — nunca só a cor — diz a situação.
 */
export function RenditionStatusBadge({ status }: { readonly status: RenditionStatus }) {
  const t = useTranslations('documents.renditions.status');
  return (
    <span data-status={status} className={`${BASE} ${TONES[status]}`}>
      {t(status)}
    </span>
  );
}
