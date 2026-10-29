'use client';

import { Avatar, ChevronRight, StatusChip, cx } from '@contrataflow/ui';
import { useFormatter, useTranslations } from 'next-intl';

import type { ShellMembership } from '@/lib/session/types';

const EXTERNAL = 'EXTERNAL';
const ACTIVE = 'ACTIVE';
const OFFBOARDING = 'OFFBOARDING';

/** Aviso do cartão: instituição em encerramento (utilizável) ou motivo de estar indisponível. */
function noteKey(
  membership: ShellMembership,
): 'readOnly' | 'unavailable' | 'membershipInactive' | null {
  const { status } = membership.tenant;
  if (membership.usable) return status === OFFBOARDING ? 'readOnly' : null;
  // Instituição fora de ACTIVE (FA-08); com a instituição ativa, o vínculo é que não dá acesso.
  return status === ACTIVE ? 'membershipInactive' : 'unavailable';
}

/**
 * Lista de instituições de SCR-101 (`TenantList` — login da US-087 e troca da US-093): utilizáveis
 * primeiro, a ativa destacada, as indisponíveis desabilitadas com o motivo. Cada vínculo é um cartão
 * com o avatar (iniciais) da instituição, o nome, os chips "Atual"/"Vínculo externo" e a validade.
 */
export function InstitutionList({
  memberships,
  activeTenantId = null,
  pendingMembershipId,
  onSelect,
}: {
  readonly memberships: readonly ShellMembership[];
  /** Instituição ativa da sessão (destacada como "atual"). */
  readonly activeTenantId?: string | null;
  /** Vínculo em troca neste momento (bloqueia novas escolhas). */
  readonly pendingMembershipId: string | null;
  readonly onSelect: (membership: ShellMembership) => void;
}) {
  const t = useTranslations('auth.selectTenant');
  const format = useFormatter();
  // Utilizáveis primeiro; a ordem original (da API) é mantida dentro de cada grupo.
  const ordered = [
    ...memberships.filter((membership) => membership.usable),
    ...memberships.filter((membership) => !membership.usable),
  ];

  return (
    <ul aria-label={t('listLabel')} className="mt-6 flex flex-col gap-3">
      {ordered.map((membership) => {
        const { tenant } = membership;
        const pending = pendingMembershipId === membership.membershipId;
        const busy = pendingMembershipId !== null;
        const current = activeTenantId === tenant.id;
        const external = membership.type === EXTERNAL;
        const validity =
          membership.usable && membership.expiresAt
            ? t('validUntil', {
                date: format.dateTime(new Date(membership.expiresAt), {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                }),
              })
            : null;
        const note = noteKey(membership);
        const noteId = `instituicao-${membership.membershipId}-nota`;

        return (
          <li key={membership.membershipId}>
            <button
              type="button"
              aria-busy={pending}
              aria-disabled={!membership.usable || busy || undefined}
              aria-current={current ? 'true' : undefined}
              aria-describedby={note ? noteId : undefined}
              onClick={() => {
                if (membership.usable && !busy) onSelect(membership);
              }}
              className={cx(
                'group flex w-full items-center gap-4 rounded-card border px-5 py-4 text-left transition',
                membership.usable
                  ? 'border-border bg-surface shadow-card hover:border-primary/50 hover:bg-primary-soft'
                  : 'cursor-not-allowed border-border bg-muted',
                current && 'border-primary ring-1 ring-primary',
                membership.usable && busy && !pending && 'cursor-wait opacity-70',
              )}
            >
              <Avatar
                name={tenant.name}
                className={cx('size-11 text-sm', membership.usable ? undefined : 'opacity-60')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={cx(
                      'font-semibold',
                      membership.usable ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {tenant.name}
                  </span>
                  {current ? <StatusChip tone="info">{t('current')}</StatusChip> : null}
                  {external ? <StatusChip tone="approval">{t('external')}</StatusChip> : null}
                </span>
                {validity ? (
                  <span className="mt-1 block text-xs text-muted-foreground">{validity}</span>
                ) : null}
                {note ? (
                  <span
                    id={noteId}
                    className={cx(
                      'mt-1 block text-sm',
                      membership.usable ? 'text-warning' : 'font-medium text-muted-foreground',
                    )}
                  >
                    {t(note)}
                  </span>
                ) : null}
              </span>
              {pending ? (
                <span className="flex-none text-sm font-medium text-primary">{t('selecting')}</span>
              ) : membership.usable ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-5 flex-none text-muted-foreground group-hover:text-primary"
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
