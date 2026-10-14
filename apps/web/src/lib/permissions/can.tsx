'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';

import { usePermission } from './use-permission';

/*
 * `<Can permission="…">` (architecture.md §8.11 · RN-FND-92): oculta quando a ação nunca seria
 * possível (sem a permissão) e desabilita com explicação quando a indisponibilidade é contextual
 * (`meta.allowedActions`/`available-actions` da API). A UI nunca reimplementa política.
 */

export type CanState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'enabled' };

export const DEFAULT_UNAVAILABLE_REASON = 'Ação indisponível no momento.';

export function resolveCanState(input: {
  readonly allowed: boolean;
  readonly action?: string | undefined;
  readonly allowedActions?: readonly string[] | undefined;
  readonly unavailableReason?: string | undefined;
}): CanState {
  if (!input.allowed) return { kind: 'hidden' };
  if (
    input.action !== undefined &&
    input.allowedActions &&
    !input.allowedActions.includes(input.action)
  ) {
    return { kind: 'disabled', reason: input.unavailableReason ?? DEFAULT_UNAVAILABLE_REASON };
  }
  return { kind: 'enabled' };
}

export interface CanRenderProps {
  readonly disabled: boolean;
  /** `id` do texto explicativo, para `aria-describedby` do controle. */
  readonly describedBy: string | undefined;
}

export interface CanProps {
  readonly permission: string;
  /** Ação contextual conferida em `allowedActions` (ex.: `forward`). */
  readonly action?: string | undefined;
  readonly allowedActions?: readonly string[] | undefined;
  /** Motivo exibido quando a ação está indisponível no contexto (vem da API). */
  readonly unavailableReason?: string | undefined;
  readonly children: ReactNode | ((props: CanRenderProps) => ReactNode);
}

export function Can({ permission, action, allowedActions, unavailableReason, children }: CanProps) {
  const { allowed } = usePermission(permission);
  const reasonId = useId();
  const state = resolveCanState({ allowed, action, allowedActions, unavailableReason });
  if (state.kind === 'hidden') return null;

  const disabled = state.kind === 'disabled';
  const describedBy = disabled ? reasonId : undefined;
  const content =
    typeof children === 'function' ? (
      children({ disabled, describedBy })
    ) : disabled ? (
      // Sem render-prop, um fieldset desabilitado bloqueia todos os controles de dentro.
      <fieldset disabled aria-describedby={reasonId} className="contents">
        {children}
      </fieldset>
    ) : (
      children
    );
  return (
    <>
      {content}
      {state.kind === 'disabled' ? (
        <p id={reasonId} className="mt-1 text-sm text-muted-foreground">
          {state.reason}
        </p>
      ) : null}
    </>
  );
}
