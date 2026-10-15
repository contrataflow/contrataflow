/**
 * Política de MFA por instituição (DEC-133 · POL-14 · `security.mfaPolicy` — entities.md §6),
 * compartilhada pelo pipeline de guards e pelo módulo `identity` (troca de instituição — US-093):
 * funções puras, sem I/O.
 */

export const MFA_POLICIES = ['NONE', 'ADMINS', 'ALL'] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

/** Padrão do registro de configurações (entities.md §6): obrigatório para permissões `HIGH`. */
export const DEFAULT_MFA_POLICY: MfaPolicy = 'ADMINS';

/** Valores de `amr` que comprovam segundo fator (RFC 8176). */
export const MFA_AMR_VALUES: readonly string[] = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face'];

/** A sessão (o `amr` do token) comprova segundo fator. */
export function hasSecondFactor(amr: readonly string[]): boolean {
  return amr.some((method) => MFA_AMR_VALUES.includes(method));
}

/**
 * Entrar na instituição exige segundo fator que a sessão não tem (RN-IAM-69): só com
 * `security.mfaPolicy = ALL`, em que toda requisição autenticada exige MFA (RN-IAM-39). Com
 * `ADMINS`, o MFA é cobrado na ação de risco alto (POL-14), não na entrada; com `NONE`, nunca.
 */
export function tenantEntryRequiresMfa(policy: MfaPolicy, amr: readonly string[]): boolean {
  return policy === 'ALL' && !hasSecondFactor(amr);
}
