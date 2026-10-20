import 'server-only';

import { clearCookie, serializeCookie } from '../cookies';
import { DEFAULT_RETURN_TO, safeReturnTo } from '../return-to';
import type { LoginTransaction } from './login-transaction';
import { IdentityProviderUnavailableError } from '../session/types';

/*
 * Recuperação de senha (US-089 · authentication.md §8 · DEC-130): o fluxo inteiro é do Authentik.
 * O BFF só monta a URL do *flow* de recuperação — sem e-mail, senha nem identificador do usuário
 * (RN-IAM-34) — e confere que o IdP responde antes de mandar o navegador para lá. No fim, o
 * Authentik devolve o usuário a `/entrar?motivo=senha-redefinida`, sem sessão nova.
 */

/** Slug do *flow* publicado por infra/authentik/blueprints/12-contrataflow-recovery.yaml. */
export const DEFAULT_RECOVERY_FLOW_SLUG = 'contrataflow-recovery';

/** Destino final do *flow* de recuperação (estágio de redirecionamento do blueprint). */
export const PASSWORD_RESET_DONE_PATH = '/entrar?motivo=senha-redefinida';

/** Tempo-limite da sondagem do IdP (o redirecionamento do BFF não pode ficar preso nele). */
const PROBE_TIMEOUT_MS = 2_000;

/** Sondagem bem-sucedida vale 10 s: rajadas de pedidos não viram uma chamada ao IdP cada. */
const PROBE_TTL_MS = 10_000;

/** IdP fora do ar ou *flow* não publicado; `providerStatus` vai para o log (`null` = rede). */
export class PasswordRecoveryUnavailableError extends IdentityProviderUnavailableError {
  constructor(
    readonly providerStatus: number | null,
    options?: { cause?: unknown },
  ) {
    super(options);
    this.name = 'PasswordRecoveryUnavailableError';
  }
}

export interface PasswordRecovery {
  /**
   * URL absoluta do *flow* de recuperação do IdP.
   * @throws PasswordRecoveryUnavailableError IdP fora do ar ou *flow* inexistente
   */
  recoveryUrl(): Promise<string>;
}

/**
 * `BuildAuthentikRecoveryUrl` (US-089): interface de *flow* do Authentik (`/if/flow/<slug>/`) na
 * origem do emissor OIDC. Sem parâmetros — nada do usuário, da sessão ou do tenant vai na URL.
 */
export function buildAuthentikRecoveryUrl(issuerUrl: string, flowSlug: string): string {
  return new URL(`/if/flow/${encodeURIComponent(flowSlug)}/`, new URL(issuerUrl).origin).href;
}

export interface AuthentikPasswordRecoveryOptions {
  readonly issuerUrl: string;
  readonly flowSlug: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Recuperação no Authentik: antes de redirecionar, um `GET` na página do *flow* confirma que o
 * IdP responde e que o *flow* existe (o Authentik responde 404 a slug desconhecido — o risco de
 * configuração apontado pela story). Sem resposta 200, o usuário fica no ContrataFlow com a
 * mensagem de indisponibilidade em vez de cair numa página de erro do navegador.
 */
export class AuthentikPasswordRecovery implements PasswordRecovery {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private verifiedAt: number | null = null;

  constructor(private readonly options: AuthentikPasswordRecoveryOptions) {
    this.url = buildAuthentikRecoveryUrl(options.issuerUrl, options.flowSlug);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async recoveryUrl(): Promise<string> {
    const now = this.now();
    if (this.verifiedAt !== null && now - this.verifiedAt < PROBE_TTL_MS) return this.url;
    this.verifiedAt = null;
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PasswordRecoveryUnavailableError(null, { cause: error });
    }
    await response.body?.cancel();
    if (response.status !== 200) throw new PasswordRecoveryUnavailableError(response.status);
    this.verifiedAt = now;
    return this.url;
  }
}

/**
 * Provedor fake (FA-06 da US-086 — testes e desenvolvimento sem Authentik): simula o *flow*
 * concluído no IdP e devolve direto o destino final dele.
 */
export class FakePasswordRecovery implements PasswordRecovery {
  constructor(private readonly appOrigin: string) {}

  recoveryUrl(): Promise<string> {
    return Promise.resolve(new URL(PASSWORD_RESET_DONE_PATH, this.appOrigin).href);
  }
}

/** Cookie com o `returnTo` validado de quem pediu a recuperação pelo ContrataFlow (FA-05). */
export const RECOVERY_RETURN_COOKIE = '__Host-cf_recovery_rt';

/** O link do e-mail vale 30 min (blueprint); 1 h cobre o pedido, o e-mail e a redefinição. */
export const RECOVERY_RETURN_MAX_AGE_SECONDS = 3_600;

/** `Set-Cookie` do `returnTo` da recuperação; sem destino próprio, apaga o anterior. */
export function recoveryReturnCookie(returnTo: string | null): string {
  return returnTo && returnTo !== DEFAULT_RETURN_TO
    ? serializeCookie(
        RECOVERY_RETURN_COOKIE,
        encodeURIComponent(returnTo),
        RECOVERY_RETURN_MAX_AGE_SECONDS,
      )
    : clearCookie(RECOVERY_RETURN_COOKIE);
}

function decodedCookie(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Destino a preservar em `/entrar?motivo=senha-redefinida` (FA-05): o `returnTo` guardado por
 * `GET /api/auth/forgot-password` ou, quando a recuperação partiu do formulário do Authentik, o
 * da transação de login mais recente ainda aberta neste navegador. Sempre revalidado
 * (RN-IAM-03); nada encontrado → `null` (o login segue para o início).
 */
export function pendingReturnTo(input: {
  readonly recoveryCookie: string | null;
  readonly transactions: readonly LoginTransaction[];
}): string | null {
  const fromRecovery = safeReturnTo(decodedCookie(input.recoveryCookie));
  if (fromRecovery) return fromRecovery;
  const [latest] = input.transactions
    .filter((transaction) => !transaction.stepUp)
    .sort((left, right) => right.createdAt - left.createdAt);
  const fromLogin = safeReturnTo(latest?.returnTo);
  return fromLogin && fromLogin !== DEFAULT_RETURN_TO ? fromLogin : null;
}
