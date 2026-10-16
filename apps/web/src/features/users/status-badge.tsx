import { isMembershipExpired } from '@contrataflow/validation';
import type { TenantMembershipDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

export interface StatusBadgeProps {
  readonly membership: Pick<TenantMembershipDto, 'type' | 'status' | 'expiresAt'>;
}

/**
 * Status do vínculo (SCR-029). RN-IAM-64: vínculo externo com a validade vencida aparece como
 * "Expirado" mesmo antes de o job `maintenance` gravar `EXPIRED`. O texto (nunca só a cor) diz o
 * status.
 */
export function StatusBadge({ membership }: StatusBadgeProps) {
  const t = useTranslations('users.statuses');
  const status = isMembershipExpired(membership, new Date()) ? 'EXPIRED' : membership.status;
  const tone =
    status === 'ACTIVE'
      ? 'bg-success-soft text-foreground'
      : status === 'SUSPENDED' || status === 'EXPIRED'
        ? 'bg-warning-soft text-foreground'
        : status === 'REVOKED'
          ? 'bg-destructive-soft text-foreground'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {t(status)}
    </span>
  );
}
