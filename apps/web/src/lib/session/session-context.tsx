'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { ActiveShellSession } from './types';

const SessionContext = createContext<ActiveShellSession | null>(null);

/** Sessão resolvida no servidor pelo layout de `(app)` (sem tokens). */
export function ShellSessionProvider({
  session,
  children,
}: {
  readonly session: ActiveShellSession;
  readonly children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useShellSession(): ActiveShellSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useShellSession fora do shell autenticado.');
  return session;
}

/** Tenant ativo: primeiro segmento de toda query key (RN-FND-90). */
export function useTenantId(): string {
  return useShellSession().activeTenant.id;
}
