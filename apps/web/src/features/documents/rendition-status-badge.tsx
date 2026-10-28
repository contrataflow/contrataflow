import { StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type { RenditionStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

const TONES: Readonly<Record<RenditionStatus, StatusTone>> = {
  PENDING: 'info',
  PROCESSING: 'info',
  READY: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
};

/**
 * Situação do PDF (US-067): "Gerando PDF…" (`PENDING`/`PROCESSING`), "PDF pronto", "Falha ao
 * gerar" e "Prévia expirada". O texto — nunca só a cor — diz a situação.
 */
export function RenditionStatusBadge({ status }: { readonly status: RenditionStatus }) {
  const t = useTranslations('documents.renditions.status');
  return (
    <StatusChip data-status={status} tone={TONES[status]}>
      {t(status)}
    </StatusChip>
  );
}
