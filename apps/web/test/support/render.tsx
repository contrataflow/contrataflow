// Renderização de Client Components com next-intl (pt-BR), QueryClient e sessão do shell.
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { DEFAULT_TIME_ZONE, LOCALE, messages } from '@/i18n/messages';
import { makeQueryClient } from '@/lib/query/query-client';
import { ShellSessionProvider } from '@/lib/session/session-context';
import type { ActiveShellSession } from '@/lib/session/types';

export const TENANT_A = {
  id: '0192a000-0000-7000-8000-00000000000a',
  name: 'Prefeitura A',
  status: 'ACTIVE',
  timezone: 'America/Sao_Paulo',
  primaryColor: null,
};

export const TENANT_B = {
  id: '0192a000-0000-7000-8000-00000000000b',
  name: 'Prefeitura B',
  status: 'ACTIVE',
  timezone: 'America/Manaus',
  primaryColor: '#0f766e',
};

export function shellSession(overrides: Partial<ActiveShellSession> = {}): ActiveShellSession {
  return {
    user: { id: '0192a000-0000-7000-8000-0000000000a1', displayName: 'Ana Souza' },
    activeTenant: TENANT_A,
    memberships: [
      {
        membershipId: 'm-a',
        tenant: { id: TENANT_A.id, name: TENANT_A.name, status: 'ACTIVE' },
        type: 'INTERNAL',
        expiresAt: null,
        usable: true,
      },
      {
        membershipId: 'm-b',
        tenant: { id: TENANT_B.id, name: TENANT_B.name, status: 'ACTIVE' },
        type: 'INTERNAL',
        expiresAt: null,
        usable: true,
      },
    ],
    idleExpiresAt: '2026-10-14T12:30:00.000Z',
    absoluteExpiresAt: '2026-10-15T00:00:00.000Z',
    readOnly: false,
    ...overrides,
  };
}

export function IntlProvider({ children }: { readonly children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={LOCALE} messages={messages} timeZone={DEFAULT_TIME_ZONE}>
      {children}
    </NextIntlClientProvider>
  );
}

export function renderWithShell(
  ui: ReactNode,
  options: { readonly queryClient?: QueryClient; readonly session?: ActiveShellSession } = {},
) {
  const queryClient = options.queryClient ?? makeQueryClient();
  const result = render(
    <IntlProvider>
      <QueryClientProvider client={queryClient}>
        <ShellSessionProvider session={options.session ?? shellSession()}>
          {ui}
        </ShellSessionProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  return { ...result, queryClient };
}

/** URL de um `fetch` simulado (string, URL ou Request). */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Resposta JSON da API simulada no browser. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  });
}

export function problem(status: number, code: string, correlationId = 'c-test-1'): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/x',
      code,
      correlationId,
      errors: [],
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
