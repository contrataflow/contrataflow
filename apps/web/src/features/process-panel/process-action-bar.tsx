'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  buttonClassName,
  cx,
} from '@contrataflow/ui';
import type { ActionEntry, ProcessSummaryDto, SummaryAction } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

/** Mesma ação (avanço por transição, aprovação por id) — a primária não se repete em "Mais". */
function sameAction(entry: ActionEntry, primary: SummaryAction | null): boolean {
  return (
    primary !== null &&
    entry.action === primary.action &&
    (entry.transitionKey ?? null) === (primary.transitionKey ?? null)
  );
}

/** Verbos com texto próprio na explicação da ação primária ("Encaminhar — há 1 pendência…"). */
const VERBS = ['FORWARD', 'COMPLETE', 'CLAIM', 'RESUME', 'DECIDE_APPROVAL'] as const;
type Verb = (typeof VERBS)[number];
const isVerb = (action: string): action is Verb => (VERBS as readonly string[]).includes(action);

const lowerFirst = (text: string) => text.charAt(0).toLocaleLowerCase('pt-BR') + text.slice(1);

export interface ProcessActionBarProps {
  readonly summary: ProcessSummaryDto;
  /** PRC-08 (`undefined` enquanto carrega ou se falhou — o menu "Mais" some). */
  readonly actions: readonly ActionEntry[] | undefined;
  /** Dados em cache sem atualização (FA banco): ações desabilitadas. */
  readonly frozen: boolean;
  readonly onAction: (action: SummaryAction | ActionEntry) => void;
}

/**
 * `ProcessActionBar` (SCR-006 · DEC-181 · RN-PROC-49/50): UMA ação primária — desabilitada com o
 * motivo em `aria-describedby` e o atalho "Ver pendências" (FA-05) — e o menu "Mais" com as
 * demais ações de PRC-08 (indisponíveis desabilitadas com o motivo). Sem ação primária, mostra com
 * quem o processo está (FA-02). Abaixo de 768 px fica fixa no rodapé (FA-12).
 */
export function ProcessActionBar({ summary, actions, frozen, onAction }: ProcessActionBarProps) {
  const t = useTranslations('processes.panel.actions');
  const hintId = useId();
  const primary = summary.nextStep.action;
  const others = (actions ?? []).filter((entry) => !sameAction(entry, primary));

  let primaryArea;
  if (primary === null) {
    const { responsible, where } = summary;
    let text: string = t('readOnly');
    if (responsible.user !== null) {
      text = t('withResponsible', {
        name: responsible.user.name,
        department: where.department.name,
      });
    } else if (responsible.queueDepartment !== null) {
      text = t('inQueue', { department: responsible.queueDepartment.name });
    }
    primaryArea = <p className="self-center text-sm font-medium text-muted-foreground">{text}</p>;
  } else {
    const disabled = frozen || !primary.enabled;
    const blocked = primary.reasons.find((reason) => reason.code === 'TRANSITION_BLOCKED');
    let hint: string | null = null;
    if (!primary.enabled && blocked) {
      hint = t('blockedHint', {
        action: isVerb(primary.action) ? t(`verbs.${primary.action}`) : primary.label,
        reason: lowerFirst(blocked.message),
      });
    } else if (!primary.enabled) {
      hint = primary.reasons.map((reason) => reason.message).join(' · ');
    }
    const button =
      primary.action === 'DECIDE_APPROVAL' && primary.approvalId && !frozen ? (
        <Link
          href={`/aprovacoes/${primary.approvalId}`}
          className={buttonClassName({ variant: 'primary', size: 'md' })}
          data-action={primary.action}
        >
          {primary.label}
        </Link>
      ) : (
        <Button
          variant="primary"
          aria-disabled={disabled ? true : undefined}
          aria-describedby={hint === null ? undefined : hintId}
          data-action={primary.action}
          className={cx(disabled && 'cursor-not-allowed opacity-60')}
          onClick={() => {
            if (!disabled) onAction(primary);
          }}
        >
          {primary.label}
        </Button>
      );
    primaryArea = (
      <div className="flex min-w-0 flex-col gap-1 md:items-end md:text-right">
        {button}
        {hint === null ? null : (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}{' '}
            {blocked ? (
              <a href="#pendencias" className="text-primary underline">
                {t('seePending')}
              </a>
            ) : null}
          </p>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label={t('label')}
      className="fixed inset-x-0 bottom-0 z-30 flex items-start justify-between gap-3 border-t border-border bg-surface p-3 shadow-card md:static md:z-auto md:max-w-md md:flex-none md:justify-end md:gap-2 md:border-0 md:bg-transparent md:p-0 md:shadow-none"
    >
      {primaryArea}
      {others.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonClassName({ variant: 'secondary', size: 'md' })}
            aria-label={t('moreLabel')}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-current">
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="13" cy="8" r="1.5" />
            </svg>
            {t('more')}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {others.map((entry) => {
              const unavailable = frozen || !entry.enabled;
              return (
                <DropdownMenuItem
                  key={`${entry.action}:${entry.transitionKey ?? entry.approvalId ?? ''}`}
                  disabled={unavailable}
                  data-action={entry.action}
                  className="flex-col items-start py-2"
                  onSelect={() => {
                    if (!unavailable) onAction(entry);
                  }}
                >
                  <span>{entry.label}</span>
                  {entry.reasons.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {t('unavailable', {
                        reasons: entry.reasons.map((reason) => reason.message).join(' · '),
                      })}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </section>
  );
}
