'use client';

import { Button, toast } from '@contrataflow/ui';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';

import { followStateOf } from './process-participants-model';
import { followProcess, unfollowProcess, useParticipants } from './process-participants.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

/**
 * `FollowToggleButton` (DEC-180 · FA-01 · RN-PROC-133): "Seguir" para quem vê o processo e tem
 * `PROCESS_FOLLOW`; "Seguindo" (clicar deixa de seguir) quando a participação própria é
 * `OBSERVER`; em outro papel, mostra o papel atual desabilitado. A confirmação é anunciada por
 * `aria-live`.
 */
export function FollowToggleButton({ processId }: { readonly processId: string }) {
  const t = useTranslations('processParticipants');
  const canFollow = usePermission('PROCESS_FOLLOW').allowed;
  const list = useParticipants(processId);
  const invalidate = useInvalidateProcess(processId);
  const [announcement, setAnnouncement] = useState('');

  const toggle = useMutation({
    mutationFn: (following: boolean) =>
      following ? unfollowProcess(processId) : followProcess(processId).then(() => undefined),
    onSuccess: async (_result, following) => {
      setAnnouncement(following ? t('follow.unfollowed') : t('follow.followed'));
      await invalidate();
    },
    onError: async (error: unknown) => {
      toast({
        title:
          isApiError(error) && error.status === 403
            ? (error.problem?.detail ?? error.message)
            : t('errors.unavailable'),
        tone: 'error',
      });
      await invalidate();
    },
  });

  if (list.data === undefined) return null;
  const state = followStateOf(list.data.meta);
  // Participação própria (qualquer papel) já concede seguir; sem ela, a permissão do perfil.
  if (state.kind === 'FOLLOW' && !canFollow) return null;

  return (
    <div className="flex items-center gap-2">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {state.kind === 'PARTICIPATING' ? (
        <Button size="sm" variant="secondary" disabled>
          {t('follow.participating', { role: t(`roles.${state.role}`) })}
        </Button>
      ) : (
        <Button
          size="sm"
          variant={state.kind === 'FOLLOWING' ? 'secondary' : 'primary'}
          aria-pressed={state.kind === 'FOLLOWING'}
          aria-label={state.kind === 'FOLLOWING' ? t('follow.unfollowLabel') : undefined}
          disabled={toggle.isPending}
          onClick={() => {
            toggle.mutate(state.kind === 'FOLLOWING');
          }}
        >
          {state.kind === 'FOLLOWING' ? t('follow.following') : t('follow.follow')}
        </Button>
      )}
    </div>
  );
}
