'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  cx,
  toast,
} from '@contrataflow/ui';
import type { ProcessDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { usePermission } from '@/lib/permissions/use-permission';

import { confidentialityErrorOf, setProcessConfidentiality } from './process-confidentiality.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

export interface ConfidentialBudgetToggleProps {
  readonly processId: string;
  /** PRC-04 (estado e `version` para o `If-Match`); `undefined` enquanto carrega. */
  readonly process: ProcessDto | undefined;
  /** Banco fora com dados em cache: nenhuma ação (US-004 · "Falha de banco"). */
  readonly frozen?: boolean;
}

/**
 * `ConfidentialBudgetToggle` (US-013 · SCR-006): interruptor "Orçamento sigiloso" com o estado
 * atual. Com `PROCESS_SET_CONFIDENTIAL_BUDGET`, alternar abre `ConfirmConfidentialityDialog` e
 * confirma com o PRC-33 (`If-Match` = versão do PRC-04); sem ela, aparece desabilitado com a dica
 * "Só o gestor ou a autoridade competente pode alterar". Durante a chamada fica em loading; erro
 * mantém o estado anterior com toast (412/428/403 recarregam o painel).
 */
export function ConfidentialBudgetToggle({
  processId,
  process,
  frozen = false,
}: ConfidentialBudgetToggleProps) {
  const t = useTranslations('processes.panel.confidentiality');
  const canSet = usePermission('PROCESS_SET_CONFIDENTIAL_BUDGET').allowed;
  const invalidate = useInvalidateProcess(processId);
  const [confirming, setConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const id = useId();

  const change = useMutation({
    mutationFn: (input: { readonly next: boolean; readonly version: number }) =>
      setProcessConfidentiality(processId, input.next, input.version),
    onSuccess: async (updated) => {
      setConfirming(false);
      const message = updated.isBudgetConfidential ? t('enabled') : t('disabled');
      setAnnouncement(message);
      toast({ title: message, tone: 'success' });
      await invalidate();
    },
    onError: async (error: unknown) => {
      setConfirming(false);
      const problem = confidentialityErrorOf(error);
      toast({
        title: t(`errors.${problem.key}`, { correlationId: problem.correlationId }),
        tone: 'error',
      });
      if (problem.reload) await invalidate();
    },
  });

  if (process === undefined) return null;
  const checked = process.isBudgetConfidential;
  const disabled = !canSet || frozen || change.isPending;
  const next = !checked;

  return (
    <div className="flex items-start gap-3">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-sm font-medium">
          {t('label')}
        </span>
        <span id={`${id}-hint`} className="max-w-xs text-xs text-muted-foreground">
          {canSet ? t('hint') : t('noPermission')}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        aria-busy={change.isPending || undefined}
        title={canSet ? undefined : t('noPermission')}
        disabled={disabled}
        onClick={() => {
          setConfirming(true);
        }}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-primary bg-primary' : 'border-border bg-muted',
          change.isPending ? 'animate-pulse' : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'inline-block size-4 rounded-full bg-surface shadow transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      <ConfirmConfidentialityDialog
        open={confirming}
        next={next}
        pending={change.isPending}
        onOpenChange={(open) => {
          if (!change.isPending) setConfirming(open);
        }}
        onConfirm={() => {
          change.mutate({ next, version: process.version });
        }}
      />
    </div>
  );
}

/** Diálogo de confirmação: explica o efeito de ativar ou desativar o sigilo (fluxo principal, 2). */
export function ConfirmConfidentialityDialog({
  open,
  next,
  pending,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  /** Estado pedido: `true` = ativar o sigilo. */
  readonly next: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const t = useTranslations('processes.panel.confidentiality');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')}>
        <DialogTitle>{next ? t('enableTitle') : t('disableTitle')}</DialogTitle>
        <DialogDescription>
          {next ? t('enableDescription') : t('disableDescription')}
        </DialogDescription>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={pending} onClick={onConfirm}>
            {next ? t('confirmEnable') : t('confirmDisable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
