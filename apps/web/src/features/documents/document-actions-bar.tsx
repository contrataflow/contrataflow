'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contrataflow/ui';
import type { ButtonVariant } from '@contrataflow/ui';
import type { DocumentAction } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import type { MouseEvent, RefObject } from 'react';

import { useIsDesktop } from '@/features/workflows/use-is-desktop';

/** Ações do ciclo de vida que geram botão aqui (`UPDATE` é do editor de seções — US-063). */
export const LIFECYCLE_ACTIONS = ['FINALIZE', 'SUBMIT', 'REOPEN', 'CANCEL', 'DELETE'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Ações principais: ficam sempre visíveis, mesmo abaixo de 768 px. */
const PRIMARY_ACTIONS: ReadonlySet<LifecycleAction> = new Set(['FINALIZE', 'SUBMIT']);

const VARIANTS: Record<LifecycleAction, ButtonVariant> = {
  FINALIZE: 'primary',
  SUBMIT: 'primary',
  REOPEN: 'secondary',
  CANCEL: 'secondary',
  DELETE: 'destructive',
};

/** Botões na ordem do ciclo de vida, só os que a API permite (`meta.allowedActions` — RN-FND-92). */
export function lifecycleActionsOf(allowed: readonly DocumentAction[]): LifecycleAction[] {
  return LIFECYCLE_ACTIONS.filter((action) => allowed.includes(action));
}

export interface DocumentActionsBarProps {
  /** `meta.allowedActions` do DOC-03: a UI nunca recalcula a regra. */
  readonly allowedActions: readonly DocumentAction[];
  /** Enquanto uma transição está em curso, nada novo pode ser disparado. */
  readonly busy?: boolean | undefined;
  /** Rótulo próprio do tipo (US-023: "Concluir ETP"); ausente = o genérico da ação. */
  readonly labels?: Partial<Record<LifecycleAction, string>> | undefined;
  /** `opener` é o elemento que devolve o foco quando o fluxo aberto pela ação fecha. */
  readonly onAction: (action: LifecycleAction, opener: HTMLElement | null) => void;
}

/**
 * `DocumentActionsBar` (US-065 · SCR-105): um botão por ação permitida. Abaixo de 768 px a barra
 * colapsa: a ação principal (Finalizar/Submeter) continua visível e as demais vão para o menu
 * "Mais ações".
 */
export function DocumentActionsBar({
  allowedActions,
  busy = false,
  labels = {},
  onAction,
}: DocumentActionsBarProps) {
  const t = useTranslations('documents.actions');
  const desktop = useIsDesktop();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const actions = lifecycleActionsOf(allowedActions);

  if (actions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('none')}</p>;
  }

  const visible = desktop ? actions : actions.filter((action) => PRIMARY_ACTIONS.has(action));
  const collapsed = desktop ? [] : actions.filter((action) => !PRIMARY_ACTIONS.has(action));

  return (
    <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
      {visible.map((action) => (
        <Button
          key={action}
          variant={VARIANTS[action]}
          disabled={busy}
          data-action={action}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            onAction(action, event.currentTarget);
          }}
        >
          {labels[action] ?? t(action)}
        </Button>
      ))}
      {collapsed.length > 0 ? (
        <MoreActions actions={collapsed} busy={busy} triggerRef={menuTrigger} onAction={onAction} />
      ) : null}
    </div>
  );
}

function MoreActions({
  actions,
  busy,
  triggerRef,
  onAction,
}: {
  readonly actions: readonly LifecycleAction[];
  readonly busy: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onAction: DocumentActionsBarProps['onAction'];
}) {
  const t = useTranslations('documents.actions');
  // O foco volta ao gatilho do menu quando o fluxo aberto por um item fecha (o item já saiu da tela).
  const chosen = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="secondary" disabled={busy}>
          {t('more')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onCloseAutoFocus={(event) => {
          if (chosen.current) {
            event.preventDefault();
            chosen.current = false;
          }
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action}
            data-action={action}
            onSelect={() => {
              chosen.current = true;
              onAction(action, triggerRef.current);
            }}
          >
            {t(action)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
