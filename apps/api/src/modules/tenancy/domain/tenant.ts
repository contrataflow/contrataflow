import type { TenantLifecycleStatus, TenantType } from '@contrataflow/types';

/*
 * Agregado `Tenant` (entities.md `Tenant` · US-099): instituição contratante, tabela de plataforma
 * escrita só pelo `SystemDbService`. A máquina de estados de RN-TEN-09 é a única forma de mudar
 * `status`; `DEACTIVATED` é final.
 */

export type TenantStatus = TenantLifecycleStatus;

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly type: TenantType;
  readonly status: TenantStatus;
  readonly stateCode: string;
  readonly ibgeCityCode: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly plan: string;
  readonly primaryOrganizationId: string | null;
  readonly activatedAt: Date | null;
  readonly suspendedAt: Date | null;
  /** Nunca exibido aos usuários do tenant nem gravado em log (RN-TEN-11). */
  readonly suspensionReason: string | null;
  readonly deactivatedAt: Date | null;
  readonly offboardingStartedAt: Date | null;
  readonly offboardingEndsAt: Date | null;
  /**
   * SHA-256 de slug + CNPJ do órgão principal + e-mail do primeiro administrador (FA-01): a
   * retomada só continua o mesmo pedido. Nunca sai nas respostas.
   */
  readonly provisioningFingerprint: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export type TenantAction = 'ACTIVATE' | 'SUSPEND' | 'OFFBOARD' | 'DEACTIVATE';

/** RN-TEN-09: estados de origem aceitos e o destino de cada ação. */
export const TENANT_TRANSITIONS: Readonly<
  Record<TenantAction, { readonly from: readonly TenantStatus[]; readonly to: TenantStatus }>
> = {
  ACTIVATE: { from: ['PROVISIONING', 'SUSPENDED', 'OFFBOARDING'], to: 'ACTIVE' },
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  OFFBOARD: { from: ['ACTIVE', 'SUSPENDED'], to: 'OFFBOARDING' },
  DEACTIVATE: { from: ['OFFBOARDING', 'PROVISIONING'], to: 'DEACTIVATED' },
};

/** Transição fora de RN-TEN-09 → 409 `INVALID_STATE` (V-08). */
export class TenantTransitionError extends Error {
  constructor(
    readonly action: TenantAction,
    readonly from: TenantStatus,
  ) {
    super(`Transição ${action} não permitida a partir de ${from}.`);
    this.name = 'TenantTransitionError';
  }
}

export function canTransition(from: TenantStatus, action: TenantAction): boolean {
  return TENANT_TRANSITIONS[action].from.includes(from);
}

/** Campos alterados pela transição (aplicados com controle de versão pelo repositório). */
export interface TenantLifecyclePatch {
  readonly status: TenantStatus;
  readonly activatedAt?: Date;
  readonly suspendedAt?: Date | null;
  readonly suspensionReason?: string | null;
  readonly offboardingStartedAt?: Date | null;
  readonly offboardingEndsAt?: Date | null;
  readonly deactivatedAt?: Date;
}

/**
 * Calcula a transição (RN-TEN-09..13):
 * - `ACTIVATE` preserva o `activatedAt` original (reativação) e limpa suspensão e encerramento;
 * - `SUSPEND` exige motivo, gravado em `suspensionReason`;
 * - `OFFBOARD` marca o início e o fim do prazo de encerramento (o motivo vai só para a auditoria);
 * - `DEACTIVATE` é final e não exclui dados (DEC-034).
 */
/** Prazo contratual de encerramento sugerido (multi-tenancy.md §13.3), quando não informado. */
export const DEFAULT_OFFBOARDING_DAYS = 90;

export function transition(
  tenant: Pick<Tenant, 'status' | 'activatedAt'>,
  action: TenantAction,
  options: {
    readonly now: Date;
    readonly reason?: string;
    /** Fim do prazo de leitura/exportação (`OFFBOARD`); padrão: agora + 90 dias. */
    readonly offboardingEndsAt?: Date;
  },
): TenantLifecyclePatch {
  if (!canTransition(tenant.status, action)) {
    throw new TenantTransitionError(action, tenant.status);
  }
  const { now } = options;
  switch (action) {
    case 'ACTIVATE':
      return {
        status: 'ACTIVE',
        activatedAt: tenant.activatedAt ?? now,
        suspendedAt: null,
        suspensionReason: null,
        offboardingStartedAt: null,
        offboardingEndsAt: null,
      };
    case 'SUSPEND':
      if (!options.reason) throw new Error('Suspensão exige motivo (RN-TEN-11).');
      return { status: 'SUSPENDED', suspendedAt: now, suspensionReason: options.reason };
    case 'OFFBOARD':
      return {
        status: 'OFFBOARDING',
        offboardingStartedAt: now,
        offboardingEndsAt:
          options.offboardingEndsAt ??
          new Date(now.getTime() + DEFAULT_OFFBOARDING_DAYS * 86_400_000),
      };
    case 'DEACTIVATE':
      return { status: 'DEACTIVATED', deactivatedAt: now };
  }
}

/** Rótulos pt-BR do status nas mensagens de `INVALID_STATE` ("a instituição está suspensa"). */
export const TENANT_STATUS_LABELS: Readonly<Record<TenantStatus, string>> = {
  PROVISIONING: 'em provisionamento',
  ACTIVE: 'ativa',
  SUSPENDED: 'suspensa',
  OFFBOARDING: 'em encerramento',
  DEACTIVATED: 'desativada',
};

export const TENANT_ACTION_LABELS: Readonly<Record<TenantAction, string>> = {
  ACTIVATE: 'ativar',
  SUSPEND: 'suspender',
  OFFBOARD: 'encerrar',
  DEACTIVATE: 'desativar',
};
