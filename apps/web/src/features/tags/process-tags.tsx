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
import { TAG_LIMITS } from '@contrataflow/validation';
import type { ActionEntry } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { keepKnown, nextSelection, pickerOptions, selectionChanged } from './tag-model';
import type { AppliedTag } from './tag-model';
import { TagPicker } from './tag-picker';
import { createTag, processTagsErrorOf, setProcessTags, tagKeys, useTags } from './tags.api';
import type { ProcessTagsErrorKey } from './tags.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

/** "Etiquetas" no cabeçalho (PRC-08 `MANAGE_TAGS` — FA-04): ausente sem `PROCESS_UPDATE`. */
export function ProcessTagsButton({
  entry,
  count,
  frozen,
  onClick,
}: {
  /** A ação `MANAGE_TAGS` do PRC-08 (`undefined` = sem `PROCESS_UPDATE` ou ainda carregando). */
  readonly entry: ActionEntry | undefined;
  readonly count: number;
  /** Banco fora com dados em cache: nenhuma ação. */
  readonly frozen: boolean;
  readonly onClick: () => void;
}) {
  const t = useTranslations('tags.header');
  const reasonId = useId();
  if (entry === undefined) return null;
  const reason = entry.enabled ? null : (entry.reasons[0]?.message ?? null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={frozen || !entry.enabled}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={onClick}
      >
        {count > 0 ? t('buttonCount', { count }) : t('button')}
      </Button>
      {reason === null ? null : (
        <p id={reasonId} className="max-w-xs text-xs text-muted-foreground">
          {reason}
        </p>
      )}
    </div>
  );
}

export interface ProcessTagsDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Etiquetas hoje aplicadas (cabeçalho do PRC-07). */
  readonly applied: readonly AppliedTag[];
  /** Versão do processo (PRC-04) enviada em `If-Match`; `undefined` enquanto carrega. */
  readonly version: number | undefined;
}

/**
 * Seletor de etiquetas do processo (US-007 · SCR-006): lista as etiquetas ativas (TAG-01) com busca,
 * limite de 10 e criação rápida para `TAG_MANAGE`; confirmar envia o conjunto completo (PRC-18) com a
 * versão do processo. O formulário só existe com o diálogo aberto: cada abertura parte do conjunto
 * aplicado, e um 412 (processo alterado por outra pessoa) recarrega o painel SEM descartar as
 * etiquetas que a pessoa marcou — ela confirma de novo com a versão nova.
 */
export function ProcessTagsDialog({
  processId,
  open,
  onOpenChange,
  applied,
  version,
}: ProcessTagsDialogProps) {
  const t = useTranslations('tags.picker');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        className="max-h-[90vh] overflow-y-auto max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-w-none max-md:translate-y-0 max-md:rounded-b-none md:max-w-lg"
      >
        <ProcessTagsForm
          processId={processId}
          applied={applied}
          version={version}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProcessTagsForm({
  processId,
  applied,
  version,
  onClose,
}: {
  readonly processId: string;
  readonly applied: readonly AppliedTag[];
  readonly version: number | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('tags.picker');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const invalidateProcess = useInvalidateProcess(processId);
  const canManage = usePermission('TAG_MANAGE').allowed;
  const tags = useTags(canManage);
  const initial = applied.map((tag) => tag.id);
  const [selected, setSelected] = useState<string[]>(initial);
  const [error, setError] = useState<ProcessTagsErrorKey | null>(null);
  const [correlationId, setCorrelationId] = useState('—');
  const [createError, setCreateError] = useState<string | null>(null);

  const options = pickerOptions(tags.data ?? [], applied);
  const knownNames = [...(tags.data ?? []), ...applied];

  const apply = useMutation({
    mutationFn: (input: { readonly tagIds: readonly string[]; readonly version: number }) =>
      setProcessTags(processId, input.tagIds, input.version),
    onSuccess: async () => {
      setError(null);
      onClose();
      toast({ title: t('applied'), tone: 'success' });
      await invalidateProcess();
    },
    onError: async (failure: unknown) => {
      const problem = processTagsErrorOf(failure);
      setError(problem.key);
      setCorrelationId(problem.correlationId);
      if (problem.key === 'validation') {
        await queryClient.invalidateQueries({ queryKey: tagKeys.all(tenantId) });
      }
      if (problem.reload) await invalidateProcess();
    },
  });

  const create = useIdempotentMutation({
    mutationFn: (name: string, context) => createTag({ name }, context),
    onSuccess: (tag) => {
      setCreateError(null);
      void queryClient.invalidateQueries({ queryKey: tagKeys.all(tenantId) });
      setSelected((current) =>
        current.includes(tag.id) ? current : nextSelection(current, tag.id),
      );
    },
  });

  const createQuick = (name: string) => {
    setCreateError(null);
    create.submit(name).catch((failure: unknown) => {
      setCreateError(
        isApiError(failure) && failure.status === 409 ? t('nameTaken') : t('createFailed'),
      );
    });
  };

  const changed = selectionChanged(initial, selected);
  const busy = apply.isPending;
  const canConfirm = changed && !busy && version !== undefined && tags.data !== undefined;

  return (
    <>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description', { max: TAG_LIMITS.perProcess })}</DialogDescription>

      {error === null ? null : (
        <Alert
          tone={error === 'conflict' ? 'warning' : 'error'}
          title={t(`errors.${error}`, { correlationId })}
        />
      )}

      {tags.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}

      {tags.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void tags.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {tags.data === undefined ? null : (
        <TagPicker
          options={options}
          knownNames={knownNames}
          selected={keepKnown(selected, options)}
          onSelectedChange={setSelected}
          canCreate={canManage}
          onCreate={createQuick}
          creating={create.isPending}
          createError={createError}
          disabled={busy}
        />
      )}

      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!canConfirm}
          aria-busy={busy || undefined}
          onClick={() => {
            if (version !== undefined) {
              apply.mutate({ tagIds: keepKnown(selected, options), version });
            }
          }}
        >
          {busy ? t('saving') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
