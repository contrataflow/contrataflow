import type { PermissionRiskLevel } from '@contrataflow/types';

import type { MfaPolicy } from '#shared/auth/mfa-policy.js';

/*
 * Fórmula de decisão (US-097 · RN-IAM-100 · permissions.md §1):
 *   autenticado ∧ tenant ACTIVE ∧ vínculo ACTIVE e não expirado
 *   ∧ permissão concedida por (perfil com escopo que cubra o recurso) ∪ (participação no processo)
 *   ∧ (MFA satisfeito, se a permissão for HIGH e a política exigir)
 *   ∧ política contextual da ação.
 * A permissão vem antes do MFA: quem não pode a ação não é convidado a confirmar a identidade. As
 * políticas contextuais são avaliadas depois, pelo serviço, só quando esta decisão permite.
 */

export interface DecisionInput {
  readonly authenticated: boolean;
  readonly tenantActive: boolean;
  readonly membershipActive: boolean;
  readonly riskLevel: PermissionRiskLevel;
  readonly grantedByRole: boolean;
  readonly grantedByParticipation: boolean;
  /**
   * `security.mfaPolicy` do tenant. Quem chama só precisa lê-la quando a permissão é `HIGH` e a
   * sessão não tem 2º fator (`mfaPolicyNeeded`); nos demais casos ela não muda a decisão.
   */
  readonly mfaPolicy: MfaPolicy;
  readonly hasSecondFactor: boolean;
}

export type DenialCode =
  | 'UNAUTHENTICATED'
  | 'TENANT_SUSPENDED'
  | 'MEMBERSHIP_INACTIVE'
  | 'PERMISSION_DENIED'
  | 'MFA_REQUIRED';

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly code: DenialCode };

/** POL-14: permissão `HIGH` com `security.mfaPolicy` `ADMINS` ou `ALL` exige sessão com MFA. */
export function requiresMfa(riskLevel: PermissionRiskLevel, policy: MfaPolicy): boolean {
  return riskLevel === 'HIGH' && policy !== 'NONE';
}

/** A decisão depende de `security.mfaPolicy` (evita ler a configuração a cada requisição). */
export function mfaPolicyNeeded(riskLevel: PermissionRiskLevel, hasSecondFactor: boolean): boolean {
  return riskLevel === 'HIGH' && !hasSecondFactor;
}

export function decide(input: DecisionInput): Decision {
  if (!input.authenticated) return { allowed: false, code: 'UNAUTHENTICATED' };
  if (!input.tenantActive) return { allowed: false, code: 'TENANT_SUSPENDED' };
  if (!input.membershipActive) return { allowed: false, code: 'MEMBERSHIP_INACTIVE' };
  if (!input.grantedByRole && !input.grantedByParticipation) {
    return { allowed: false, code: 'PERMISSION_DENIED' };
  }
  if (!input.hasSecondFactor && requiresMfa(input.riskLevel, input.mfaPolicy)) {
    return { allowed: false, code: 'MFA_REQUIRED' };
  }
  return { allowed: true };
}
