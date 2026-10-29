import { StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import { isMembershipExpired } from '@contrataflow/validation';
import type { TenantMembershipDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

export interface StatusBadgeProps {
  readonly membership: Pick<TenantMembershipDto, 'type' | 'status' | 'expiresAt'>;
}

const TONES: Readonly<Record<string, StatusTone>> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  EXPIRED: 'warning',
  REVOKED: 'danger',
  INVITED: 'info',
};

/**
 * Status do vínculo (SCR-029) como `StatusChip` do kit. RN-IAM-64: vínculo externo com a validade
 * vencida aparece como "Expirado" mesmo antes de o job `maintenance` gravar `EXPIRED`. O texto
 * (nunca só a cor) diz o status.
 */
export function StatusBadge({ membership }: StatusBadgeProps) {
  const t = useTranslations('users.statuses');
  const status = isMembershipExpired(membership, new Date()) ? 'EXPIRED' : membership.status;
  return <StatusChip tone={TONES[status] ?? 'neutral'}>{t(status)}</StatusChip>;
}
