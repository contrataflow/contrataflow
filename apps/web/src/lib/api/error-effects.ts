import { isApiError } from './api-error';
import { resolveErrorAction } from './error-policy';

/*
 * Efeitos globais da política de erros (architecture.md §8.12) para consultas e mutações dos
 * Client Components. 404/5xx de consultas não passam por aqui: vão ao `error.tsx` do segmento.
 */

export interface ErrorEffectDeps {
  readonly currentPath: () => string;
  readonly navigate: (href: string) => void;
  readonly openConflict: () => void;
  readonly notify: (input: {
    title: string;
    description?: string | undefined;
    tone: 'error' | 'info';
  }) => void;
  readonly messages: {
    readonly rateLimited: (seconds: number | null) => string;
    readonly csrf: string;
    readonly csrfHint: string;
    readonly unexpected: string;
    readonly notFound: string;
    readonly correlation: (correlationId: string) => string;
  };
}

export type ErrorSource = 'query' | 'mutation';

export function applyErrorEffect(error: unknown, source: ErrorSource, deps: ErrorEffectDeps): void {
  if (!isApiError(error)) {
    if (source === 'mutation') deps.notify({ title: deps.messages.unexpected, tone: 'error' });
    return;
  }
  const action = resolveErrorAction(error, deps.currentPath());
  const code = error.correlationId ? deps.messages.correlation(error.correlationId) : undefined;
  switch (action.kind) {
    case 'redirect':
      deps.navigate(action.href);
      return;
    case 'session-expired':
    case 'unavailable':
      // Modal "Sua sessão expirou" ou banner de indisponibilidade: o interceptador do cliente de
      // API já avisou o `SessionWatcher`; a tela e o que foi digitado continuam (US-088).
      return;
    case 'reload':
      deps.notify({
        title: deps.messages.csrf,
        description: deps.messages.csrfHint,
        tone: 'error',
      });
      return;
    case 'rate-limited':
      deps.notify({ title: deps.messages.rateLimited(action.retryAfterSeconds), tone: 'info' });
      return;
    case 'conflict':
      if (source === 'mutation') deps.openConflict();
      return;
    case 'not-found':
      if (source === 'mutation') deps.notify({ title: deps.messages.notFound, tone: 'error' });
      return;
    case 'boundary':
      if (source === 'mutation')
        deps.notify({ title: deps.messages.unexpected, description: code, tone: 'error' });
      return;
    case 'inline':
      // Erros de campo, violações e 403 de política: exibidos pela própria tela.
      return;
  }
}
