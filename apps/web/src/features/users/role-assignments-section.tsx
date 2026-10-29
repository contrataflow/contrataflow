'use client';

import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Plus,
  ShieldCheck,
  Skeleton,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
  toast,
} from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
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

const PHASE_TONE: Readonly<Record<string, StatusTone>> = {
  SCHEDULED: 'info',
  ENDED: 'neutral',
};

/**
 * Aba "Atribuições" do SCR-029 (US-096): tabela das atribuições (ROL-10 — perfil, escopo, vigência,
 * quem concedeu), com "Atribuir perfil" (painel lateral) e "Revogar" (menu ⋯ da linha) só para
 * quem tem `ROLE_ASSIGN` (`meta.canAssign`). Revogar a própria última atribuição administrativa é
 * avisado sem chamar a API (FA-05 · POL-16).
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
    <h2 id={headingId} className="text-section-title text-brand-ink">
      {t('title')}
    </h2>
  );

  if (list.isPending) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        {heading}
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
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

  const askRevoke = (assignment: RoleAssignmentDto) => {
    if (meta.isSelf && isLastAdministrativeAssignment(assignment, assignments, new Date())) {
      // FA-05 (POL-16): avisa sem chamar a API.
      setNotice(t('selfProtected'));
      return;
    }
    setNotice(null);
    setRevoking(assignment);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        {canAssign ? (
          <Button
            variant="secondary"
            iconLeft={<Plus />}
            onClick={() => {
              setNotice(null);
              setAssigning(true);
            }}
          >
            {t('assign')}
          </Button>
        ) : null}
      </div>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Alert tone="warning" title={notice} /> : null}
      </div>

      {assignments.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title={t('empty')} />
      ) : (
        <TableContainer label={t('listLabel')}>
          <Table>
            <caption className="sr-only">{t('listLabel')}</caption>
            <TableHead>
              <Tr>
                <Th>{t('role')}</Th>
                <Th>{t('scope')}</Th>
                <Th className="hidden sm:table-cell">{t('validity')}</Th>
                <Th className="hidden md:table-cell">{t('grantedBy')}</Th>
                {meta.canAssign ? (
                  <Th className="w-12">
                    <span className="sr-only">{t('actions')}</span>
                  </Th>
                ) : null}
              </Tr>
            </TableHead>
            <TableBody>
              {assignments.map((assignment) => {
                const phase = assignmentPhase(assignment, now);
                return (
                  <Tr key={assignment.id}>
                    <th scope="row" className="px-3.5 py-3 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-foreground">{assignment.roleName}</span>
                        {phase === 'EFFECTIVE' ? null : (
                          <StatusChip tone={PHASE_TONE[phase] ?? 'neutral'}>
                            {t(`phase.${phase}`)}
                          </StatusChip>
                        )}
                      </span>
                    </th>
                    <Td>
                      {t(`scopes.${assignment.scopeType}`)}
                      {assignment.scopeName ? ` — ${assignment.scopeName}` : ''}
                      {assignment.scopeType === 'DEPARTMENT' ||
                      assignment.scopeType === 'OWN_DEPARTMENTS' ? (
                        <span className="block text-xs text-muted-foreground">
                          {assignment.includeSubtree ? t('withSubtree') : t('withoutSubtree')}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="hidden sm:table-cell">
                      {assignment.validUntil
                        ? t('validityRange', {
                            from: date(assignment.validFrom),
                            until: date(assignment.validUntil),
                          })
                        : t('validityOpen', { from: date(assignment.validFrom) })}
                    </Td>
                    <Td className="hidden md:table-cell">
                      {t('grantedByValue', {
                        name: assignment.grantedBy?.name ?? t('system'),
                        date: date(assignment.grantedAt),
                      })}
                    </Td>
                    {meta.canAssign ? (
                      <Td className="w-12 py-1.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('menu', { role: assignment.roleName })}
                              className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                            >
                              <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => {
                                askRevoke(assignment);
                              }}
                            >
                              {t('revokeLabel', { role: assignment.roleName })}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
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
