'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { isLastAdministrativeAssignment, isMembershipExpired } from '@contrataflow/validation';
import type { RoleAssignmentDto, TenantMembershipDetailDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { shouldRetryQuery } from '@/lib/query/query-client';
import { useTenantId } from '@/lib/session/session-context';

import { AssignRoleDialog } from './assign-role-dialog';
import { ConfirmRevokeDialog } from './confirm-revoke-dialog';
import { assignmentPhase } from './role-assignment-model';
import {
  ROLE_ASSIGNMENTS_STALE_TIME_MS,
  fetchRoleAssignments,
  roleAssignmentKeys,
} from './role-assignments.api';

export interface RoleAssignmentsSectionProps {
  readonly membership: TenantMembershipDetailDto;
  readonly returnTo: string;
}

/**
 * Aba "Perfis e acessos" do SCR-029 (US-096): lista as atribuições (ROL-10 — perfil, escopo,
 * vigência, quem concedeu) em cartões, com "Atribuir perfil" e "Revogar" só para quem tem
 * `ROLE_ASSIGN` (`meta.canAssign`). Revogar a própria última atribuição administrativa é avisado
 * sem chamar a API (FA-05 · POL-16).
 */
export function RoleAssignmentsSection({ membership, returnTo }: RoleAssignmentsSectionProps) {
  const t = useTranslations('users.detail.roles');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [assigning, setAssigning] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignmentDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = roleAssignmentKeys.ofUser(tenantId, membership.userId);

  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchRoleAssignments(membership.userId, signal),
    staleTime: ROLE_ASSIGNMENTS_STALE_TIME_MS,
    retry: shouldRetryQuery,
    throwOnError: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'short' });

  const heading = (
    <h2 id={headingId} className="text-lg font-semibold">
      {t('title')}
    </h2>
  );

  if (list.isPending) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        {heading}
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </section>
    );
  }

  if (list.isError) {
    const forbidden = isApiError(list.error) && list.error.status === 403;
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        {heading}
        <Alert
          tone={forbidden ? 'info' : 'error'}
          live={false}
          title={forbidden ? t('forbidden') : t('loadFailed')}
        >
          {forbidden ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void list.refetch();
              }}
            >
              {t('retry')}
            </Button>
          )}
        </Alert>
      </section>
    );
  }

  const { assignments, meta } = list.data;
  const now = new Date();
  // Vínculo fora de `ACTIVE` ou vencido não recebe perfil (RN-IAM-90).
  const canAssign =
    meta.canAssign && membership.status === 'ACTIVE' && !isMembershipExpired(membership, now);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        {canAssign ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              setAssigning(true);
            }}
          >
            {t('assign')}
          </Button>
        ) : null}
      </div>

      <div aria-live="polite">{notice ? <Alert tone="warning" title={notice} /> : null}</div>

      {assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label={t('listLabel')}>
          {assignments.map((assignment) => {
            const phase = assignmentPhase(assignment, now);
            return (
              <li
                key={assignment.id}
                className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{assignment.roleName}</span>
                  {phase === 'EFFECTIVE' ? null : (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                      {t(`phase.${phase}`)}
                    </span>
                  )}
                </div>
                <dl className="grid gap-1 text-sm text-muted-foreground">
                  <div>
                    <dt className="inline font-medium text-foreground">{t('scope')}: </dt>
                    <dd className="inline">
                      {t(`scopes.${assignment.scopeType}`)}
                      {assignment.scopeName ? ` — ${assignment.scopeName}` : ''}
                      {assignment.scopeType === 'DEPARTMENT' ||
                      assignment.scopeType === 'OWN_DEPARTMENTS'
                        ? ` (${assignment.includeSubtree ? t('withSubtree') : t('withoutSubtree')})`
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">{t('validity')}: </dt>
                    <dd className="inline">
                      {assignment.validUntil
                        ? t('validityRange', {
                            from: date(assignment.validFrom),
                            until: date(assignment.validUntil),
                          })
                        : t('validityOpen', { from: date(assignment.validFrom) })}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">{t('grantedBy')}: </dt>
                    <dd className="inline">
                      {t('grantedByValue', {
                        name: assignment.grantedBy?.name ?? t('system'),
                        date: date(assignment.grantedAt),
                      })}
                    </dd>
                  </div>
                </dl>
                {meta.canAssign ? (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('revokeLabel', { role: assignment.roleName })}
                      onClick={() => {
                        if (
                          meta.isSelf &&
                          isLastAdministrativeAssignment(assignment, assignments, new Date())
                        ) {
                          // FA-05 (POL-16): avisa sem chamar a API.
                          setNotice(t('selfProtected'));
                          return;
                        }
                        setNotice(null);
                        setRevoking(assignment);
                      }}
                    >
                      {t('revoke')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <AssignRoleDialog
        open={assigning}
        membership={membership}
        returnTo={returnTo}
        onClose={() => {
          setAssigning(false);
        }}
        onAssigned={(assignment) => {
          setAssigning(false);
          refresh();
          toast({ title: t('toast.assigned', { role: assignment.roleName }), tone: 'success' });
        }}
      />
      <ConfirmRevokeDialog
        assignment={revoking}
        returnTo={returnTo}
        onClose={() => {
          setRevoking(null);
        }}
        onRevoked={(assignment) => {
          setRevoking(null);
          refresh();
          toast({ title: t('toast.revoked', { role: assignment.roleName }), tone: 'success' });
        }}
        onStale={(message) => {
          setNotice(message);
          refresh();
        }}
      />
    </section>
  );
}
