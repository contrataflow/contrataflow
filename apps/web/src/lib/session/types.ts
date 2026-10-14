/*
 * Visão pública da sessão (`GET /api/auth/session` e props do shell): nunca contém token, cookie
 * ou identificador de sessão — só o que a interface exibe (DEC-053).
 */

export interface ShellTenant {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly timezone: string;
  readonly primaryColor: string | null;
}

export interface ShellMembership {
  readonly membershipId: string;
  readonly tenant: Pick<ShellTenant, 'id' | 'name' | 'status'>;
  readonly usable: boolean;
}

export interface ShellSession {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly activeTenant: ShellTenant | null;
  /** Vínculos para o seletor de instituição (ME-04 assume com a US-093). */
  readonly memberships: readonly ShellMembership[];
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly readOnly: boolean;
}

/** Sessão com instituição ativa — a única que o layout de `(app)` entrega ao shell. */
export type ActiveShellSession = ShellSession & { readonly activeTenant: ShellTenant };
