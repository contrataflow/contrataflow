import 'server-only';

import { CODE_MFA_METHODS } from './password-login';
import type {
  MfaMethod,
  PasswordLogin,
  PasswordLoginCredentials,
  PasswordLoginFailure,
  PasswordLoginStep,
  PendingLogin,
} from './password-login';
import type { IdentityProvider, LoginStart } from '../session/types';

/*
 * Login nativo pelo executor de fluxos do Authentik (DEC-187 · ADR-003, adendo de 2026-10-28):
 * o BFF conduz o *flow* de autenticação pela API headless (`/api/v3/flows/executor/<slug>/`) com
 * um jar de cookies só desta transação — identificação com senha, etapa de MFA quando o usuário
 * tem dispositivo, bloqueio pela política de reputação do *flow*. Com a sessão do IdP no jar, pede
 * o `authorize` (Authorization Code + PKCE, consentimento implícito) sem seguir o redirecionamento,
 * troca o código como no callback e, em seguida, encerra a sessão do IdP pelo *flow* de
 * invalidação: nada fica aberto no Authentik (o refresh token sobrevive — Authentik 2026.8).
 *
 * Contrato verificado no Authentik 2026.8.3: cada etapa concluída responde 302 para o próprio
 * executor (o cliente segue com GET); credencial inválida volta a mesma etapa com
 * `response_errors`; o fim do *flow* é `xak-flow-redirect`. CSRF não é exigido de sessão anônima,
 * mas o cabeçalho `X-authentik-CSRF` vai sempre que o cookie existir.
 */

const EXECUTOR_PREFIX = '/api/v3/flows/executor/';
const CSRF_COOKIE = 'authentik_csrf';
const CSRF_HEADER = 'X-authentik-CSRF';
/** Redirecionamentos internos do executor seguidos por passo (o normal são 1–2). */
const MAX_HOPS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;

type OidcAuthorization = Pick<IdentityProvider, 'beginLogin' | 'completeLogin'>;

export interface AuthentikPasswordLoginOptions {
  readonly issuerUrl: string;
  readonly appOrigin: string;
  /** `redirect_uri` registrado no provider (o callback do BFF). */
  readonly redirectUri: string;
  /** *Flow* de autenticação (blueprint 15). */
  readonly loginFlowSlug: string;
  /** *Flow* com a etapa de logout do usuário (encerra a sessão do IdP). */
  readonly invalidationFlowSlug: string;
  /** Cliente OIDC do BFF: monta o `authorize` (PKCE) e troca o código. */
  readonly identity: OidcAuthorization;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Cookies do IdP de uma transação de login (nunca chegam ao navegador). */
export class CookieJar {
  private readonly cookies: Map<string, string>;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.cookies = new Map(Object.entries(initial));
  }

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key = '', raw = ''] = attribute.split('=');
        const field = key.trim().toLowerCase();
        if (field === 'max-age') return Number(raw) <= 0;
        return field === 'expires' && Date.parse(raw) <= Date.now();
      });
      if (expired || value === '' || value === '""') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }
}

/** Resposta do IdP fora do contrato (5xx, rede, tempo-limite, 4xx do executor). */
class FlowUnavailableError extends Error {
  constructor(
    readonly failure: PasswordLoginFailure,
    options?: { cause?: unknown },
  ) {
    super('Executor de fluxos do IdP indisponível.', options);
    this.name = 'FlowUnavailableError';
  }
}

interface Challenge {
  readonly component: string;
  readonly response_errors?: Readonly<Record<string, unknown>>;
  readonly device_challenges?: readonly { readonly device_class?: unknown }[];
  readonly to?: unknown;
}

function isChallenge(value: unknown): value is Challenge {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { component?: unknown }).component === 'string'
  );
}

function hasErrors(challenge: Challenge): boolean {
  return Object.keys(challenge.response_errors ?? {}).length > 0;
}

function codeMethods(challenge: Challenge): MfaMethod[] {
  const classes = (challenge.device_challenges ?? []).map((device) => device.device_class);
  return CODE_MFA_METHODS.filter((method) => classes.includes(method));
}

function unavailable(
  step: string,
  providerStatus: number | null,
  component: string | null = null,
): PasswordLoginStep {
  return { kind: 'unavailable', failure: { step, providerStatus, component } };
}

export class AuthentikPasswordLogin implements PasswordLogin {
  private readonly origin: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthentikPasswordLoginOptions) {
    this.origin = new URL(options.issuerUrl).origin;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async authenticate(credentials: PasswordLoginCredentials): Promise<PasswordLoginStep> {
    const jar = new CookieJar();
    const executor = this.executorPath(this.options.loginFlowSlug);
    try {
      const first = await this.advance(
        jar,
        await this.request(jar, 'GET', executor, 'flow'),
        'flow',
      );
      if (first.component !== 'ak-stage-identification') {
        return await this.interpret(jar, first, 'flow');
      }
      let challenge = await this.advance(
        jar,
        await this.request(jar, 'POST', executor, 'flow', {
          component: 'ak-stage-identification',
          uid_field: credentials.username,
          password: credentials.password,
        }),
        'flow',
      );
      // *Flow* com a senha numa etapa separada: a mesma senha, uma vez.
      if (challenge.component === 'ak-stage-password' && !hasErrors(challenge)) {
        challenge = await this.advance(
          jar,
          await this.request(jar, 'POST', executor, 'flow', {
            component: 'ak-stage-password',
            password: credentials.password,
          }),
          'flow',
        );
      }
      return await this.interpret(jar, challenge, 'flow');
    } catch (error) {
      if (error instanceof FlowUnavailableError)
        return { kind: 'unavailable', failure: error.failure };
      throw error;
    }
  }

  async verifyCode(pending: PendingLogin, code: string): Promise<PasswordLoginStep> {
    const jar = new CookieJar(pending.cookies);
    const executor = this.executorPath(this.options.loginFlowSlug);
    try {
      const challenge = await this.advance(
        jar,
        await this.request(jar, 'POST', executor, 'mfa', {
          component: 'ak-stage-authenticator-validate',
          code,
        }),
        'mfa',
      );
      return await this.interpret(jar, challenge, 'mfa');
    } catch (error) {
      if (error instanceof FlowUnavailableError)
        return { kind: 'unavailable', failure: error.failure };
      throw error;
    }
  }

  private async interpret(
    jar: CookieJar,
    challenge: Challenge,
    step: string,
  ): Promise<PasswordLoginStep> {
    switch (challenge.component) {
      case 'xak-flow-redirect':
        return this.finish(jar);
      case 'ak-stage-identification':
      case 'ak-stage-password':
        // A etapa volta com `response_errors` (sem dizer se a conta existe — RN-IAM-18).
        return { kind: 'invalid_credentials' };
      case 'ak-stage-authenticator-validate': {
        const methods = codeMethods(challenge);
        // Só WebAuthn/Duo: não há código a digitar nesta tela.
        if (methods.length === 0) return unavailable(step, 200, 'ak-stage-authenticator-validate');
        const pending = { cookies: jar.toRecord() };
        return hasErrors(challenge)
          ? { kind: 'mfa_invalid', pending }
          : { kind: 'mfa_required', pending, methods };
      }
      case 'ak-stage-access-denied':
        return { kind: 'locked' };
      default:
        // Etapa que o login nativo não conduz (consentimento, cadastro de MFA, captcha…).
        return unavailable(step, 200, challenge.component);
    }
  }

  /**
   * Sessão do IdP aberta no jar: `authorize` com PKCE sem seguir o 302 para o callback, troca do
   * código pelo cliente OIDC e invalidação da sessão do IdP (sempre, mesmo se a troca falhar).
   */
  private async finish(jar: CookieJar): Promise<PasswordLoginStep> {
    let start: LoginStart;
    let location: string | null;
    try {
      // Descoberta OIDC fora do ar também é "IdP indisponível".
      start = await this.options.identity.beginLogin({
        appOrigin: this.options.appOrigin,
        stepUp: false,
        hint: null,
      });
      const response = await this.request(jar, 'GET', start.redirectUrl, 'authorize');
      location = response.status === 302 ? response.headers.get('Location') : null;
      await response.body?.cancel();
    } catch (error) {
      await this.invalidate(jar);
      if (error instanceof FlowUnavailableError) throw error;
      throw new FlowUnavailableError(
        { step: 'authorize', providerStatus: null, component: null },
        { cause: error },
      );
    }
    const callback = location ? new URL(location, this.origin) : null;
    const expected = new URL(this.options.redirectUri);
    if (
      callback?.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.searchParams.get('state') !== start.state
    ) {
      await this.invalidate(jar);
      // Consentimento explícito ou outra etapa no `authorize`: configuração do provider.
      return unavailable('authorize', location ? 302 : null, callback?.pathname ?? null);
    }
    const completion = await this.options.identity.completeLogin(callback.searchParams, start);
    await this.invalidate(jar);
    if (!completion.ok) {
      return unavailable('token', null, completion.reason);
    }
    return { kind: 'authenticated', login: completion.login };
  }

  /** Encerra a sessão do IdP do jar (melhor esforço: o login do BFF não depende disso). */
  private async invalidate(jar: CookieJar): Promise<void> {
    try {
      await this.advance(
        jar,
        await this.request(
          jar,
          'GET',
          this.executorPath(this.options.invalidationFlowSlug),
          'invalidation',
        ),
        'invalidation',
      );
    } catch {
      // O IdP encerra a sessão sozinho no fim do prazo do *flow* (session_duration).
    }
  }

  /** Segue os 302 do executor para ele mesmo e devolve o desafio (JSON) da etapa atual. */
  private async advance(jar: CookieJar, response: Response, step: string): Promise<Challenge> {
    let current = response;
    for (let hop = 0; current.status === 302 && hop < MAX_HOPS; hop += 1) {
      const location = current.headers.get('Location') ?? '';
      await current.body?.cancel();
      const target = new URL(location, this.origin);
      if (target.origin !== this.origin || !target.pathname.startsWith(EXECUTOR_PREFIX)) {
        throw new FlowUnavailableError({ step, providerStatus: 302, component: null });
      }
      current = await this.request(jar, 'GET', target.pathname + target.search, step);
    }
    if (current.status !== 200) {
      await current.body?.cancel();
      throw new FlowUnavailableError({ step, providerStatus: current.status, component: null });
    }
    let body: unknown;
    try {
      body = await current.json();
    } catch (error) {
      throw new FlowUnavailableError(
        { step, providerStatus: 200, component: null },
        { cause: error },
      );
    }
    if (!isChallenge(body)) {
      throw new FlowUnavailableError({ step, providerStatus: 200, component: null });
    }
    return body;
  }

  private async request(
    jar: CookieJar,
    method: 'GET' | 'POST',
    target: string,
    step: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    const url = new URL(target, this.origin);
    const headers: Record<string, string> = { accept: 'application/json' };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const csrf = jar.get(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
    if (body) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new FlowUnavailableError(
        { step, providerStatus: null, component: null },
        { cause: error },
      );
    }
    jar.absorb(response);
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new FlowUnavailableError({ step, providerStatus: response.status, component: null });
    }
    return response;
  }

  private executorPath(slug: string): string {
    return `${EXECUTOR_PREFIX}${encodeURIComponent(slug)}/?query=`;
  }
}
