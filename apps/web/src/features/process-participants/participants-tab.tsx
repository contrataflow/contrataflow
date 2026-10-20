'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { ProcessParticipantDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { AddParticipantDialog } from './add-participant-dialog';
import { removeParticipant, useParticipants } from './process-participants.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { TEXTAREA_CLASS } from '../processes/form-field';

/** Linha da lista (`ParticipantsList`): nome, papel, validade e quem concedeu. */
function ParticipantRow({
  participant,
  timeZone,
  canManage,
  onRemove,
}: {
  readonly participant: ProcessParticipantDto;
  readonly timeZone: string;
  readonly canManage: boolean;
  readonly onRemove: (participant: ProcessParticipantDto) => void;
}) {
  const t = useTranslations('processParticipants');
  const date = (iso: string) =>
    new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(
      new Date(iso),
    );
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 md:flex-row md:items-center md:gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium break-words">{participant.principal.name}</span>
        <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {participant.principalType === 'DEPARTMENT' ? <span>{t('unit')}</span> : null}
          {participant.principal.isExternal ? <span>{t('external')}</span> : null}
          {participant.notify ? null : <span>{t('notifyOff')}</span>}
        </span>
      </div>
      <span className="text-sm md:w-32">{t(`roles.${participant.role}`)}</span>
      <span className="text-sm text-muted-foreground md:w-40">
        {participant.expiresAt === null ? t('noExpiry') : date(participant.expiresAt)}
      </span>
      <span className="text-xs text-muted-foreground md:w-56">
        {t('grantedBy', {
          name: participant.grantedBy.name,
          date: date(participant.grantedAt),
        })}
      </span>
      {canManage ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('actions.removeLabel', { name: participant.principal.name })}
          onClick={() => {
            onRemove(participant);
          }}
        >
          {t('actions.remove')}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * SCR-006 · aba "Participantes" (SCR-112 · US-012): participações ativas (PRC-28), com "Adicionar"
 * e "Remover" só para quem tem `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo (`meta.canManage`);
 * os demais veem a lista em modo leitura. Skeleton, vazio e erro com "Tentar novamente".
 */
export function ParticipantsTab({ processId }: { readonly processId: string }) {
  const t = useTranslations('processParticipants');
  const id = useId();
  const session = useShellSession();
  const list = useParticipants(processId);
  const invalidate = useInvalidateProcess(processId);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProcessParticipantDto | null>(null);
  const [reason, setReason] = useState('');

  const remove = useMutation({
    mutationFn: (participant: ProcessParticipantDto) =>
      removeParticipant(participant.id, reason.trim() === '' ? null : reason.trim()),
    onSuccess: async () => {
      setRemoving(null);
      setReason('');
      toast({ title: t('toast.removed'), tone: 'success' });
      await invalidate();
    },
    onError: async (error: unknown) => {
      setRemoving(null);
      if (isApiError(error) && error.code === 'PARTICIPANT_NOT_FOUND') {
        toast({ title: t('errors.notFound'), tone: 'error' });
      } else if (isApiError(error) && error.status === 403) {
        toast({ title: error.problem?.detail ?? error.message, tone: 'error' });
      } else {
        toast({ title: t('errors.unavailable'), tone: 'error' });
      }
      await invalidate();
    },
  });

  if (list.data === undefined) {
    if (list.isPending) {
      return (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      );
    }
    return (
      <Alert tone="error" title={t('errors.load')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t('errors.retry')}
        </Button>
      </Alert>
    );
  }

  const { items, meta } = list.data;
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t('title')}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {t('count', { count: items.length })}
          </span>
        </h2>
        {meta.canManage ? (
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {meta.canManage ? t('empty') : t('emptyReadOnly')}
        </p>
      ) : (
        <ul aria-label={t('title')} className="flex flex-col">
          {items.map((participant) => (
            <ParticipantRow
              key={participant.id}
              participant={participant}
              timeZone={session.activeTenant.timezone}
              canManage={meta.canManage}
              onRemove={setRemoving}
            />
          ))}
        </ul>
      )}
      <AddParticipantDialog
        processId={processId}
        open={adding}
        onOpenChange={setAdding}
        onAdded={invalidate}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setReason('');
          }
        }}
      >
        <DialogContent closeLabel={null}>
          {/* ConfirmRemoveDialog (fluxo principal, passo 7). */}
          <DialogTitle>{t('remove.title', { name: removing?.principal.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('remove.description')}</DialogDescription>
          <label htmlFor={`${id}-reason`} className="text-sm font-medium">
            {t('remove.reason')}
          </label>
          <textarea
            id={`${id}-reason`}
            className={TEXTAREA_CLASS}
            maxLength={500}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
                setReason('');
              }}
            >
              {t('remove.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              {t('remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
