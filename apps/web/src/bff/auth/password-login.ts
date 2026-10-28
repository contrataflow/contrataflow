import 'server-only';

import type { ProviderLogin } from '../session/types';

/*
 * Login nativo (DEC-187 · adendo da ADR-003): o formulário de usuário e senha é do ContrataFlow
 * (`/entrar`) e o BFF conduz, no servidor, o fluxo de autenticação do IdP — que continua dono das
 * políticas de senha, bloqueio, MFA e recuperação. O navegador nunca vê o IdP no login.
 */

/** Classes de segundo fator que a etapa de código aceita (código digitado). */
export const CODE_MFA_METHODS = ['totp', 'static', 'email', 'sms'] as const;
export type MfaMethod = (typeof CODE_MFA_METHODS)[number];

/**
 * Transação do IdP à espera do segundo fator: os cookies da sessão do *flow* no IdP. Só existe no
 * servidor (Redis de sessões, cifrada, 5 min — `LoginChallengeStore`); o navegador recebe um id
 * opaco.
 */
export interface PendingLogin {
  readonly cookies: Readonly<Record<string, string>>;
}

/** Por que o IdP ficou indisponível no login — só escalares, sem corpo de resposta. */
export interface PasswordLoginFailure {
  /** Passo em que falhou (`flow`, `mfa`, `authorize`, `token`). */
  readonly step: string;
  /** Status HTTP do IdP; `null` sem resposta (rede/timeout). */
  readonly providerStatus: number | null;
  /** Etapa inesperada do *flow* (`component`), quando foi isso. */
  readonly component: string | null;
}

export type PasswordLoginStep =
  | { readonly kind: 'authenticated'; readonly login: ProviderLogin }
  | {
      readonly kind: 'mfa_required';
      readonly pending: PendingLogin;
      readonly methods: readonly MfaMethod[];
    }
  /** Código recusado: a transação continua (com os cookies atualizados). */
  | { readonly kind: 'mfa_invalid'; readonly pending: PendingLogin }
  /** Usuário ou senha inválidos — nunca diz qual (RN-IAM-18). */
  | { readonly kind: 'invalid_credentials' }
  /** O IdP negou o acesso (bloqueio por tentativas ou política). */
  | { readonly kind: 'locked' }
  | { readonly kind: 'unavailable'; readonly failure: PasswordLoginFailure };

export interface PasswordLoginCredentials {
  readonly username: string;
  readonly password: string;
}

export interface PasswordLogin {
  /** Usuário e senha no *flow* de autenticação do IdP. */
  authenticate(credentials: PasswordLoginCredentials): Promise<PasswordLoginStep>;
  /** Código do segundo fator na mesma transação. */
  verifyCode(pending: PendingLogin, code: string): Promise<PasswordLoginStep>;
}

/** Sem provedor configurado: o login responde "serviço de autenticação indisponível". */
export class UnconfiguredPasswordLogin implements PasswordLogin {
  authenticate(): Promise<PasswordLoginStep> {
    return Promise.resolve({
      kind: 'unavailable',
      failure: { step: 'config', providerStatus: null, component: null },
    });
  }

  verifyCode(): Promise<PasswordLoginStep> {
    return this.authenticate();
  }
}
