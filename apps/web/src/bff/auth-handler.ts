import 'server-only';

import { switchTenantRequestSchema } from '@contrataflow/validation';
import type { z } from 'zod';

import {
  addTransaction,
  LOGIN_TRANSACTION_COOKIE,
  LOGIN_TRANSACTION_MAX_AGE_SECONDS,
  openTransactions,
  sealTransactions,
  takeTransaction,
} from './auth/login-transaction';
import type { LoginTransaction } from './auth/login-transaction';
import { OidcIdentityProvider } from './auth/oidc-provider';
import {
  PasswordRecoveryUnavailableError,
  RECOVERY_RETURN_COOKIE,
  recoveryReturnCookie,
} from './auth/password-recovery';
import { clientIpFrom } from './client-ip';
import { clearCookie, readCookie, serializeCookie } from './cookies';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { checkCsrf } from './csrf';
import { jsonResponse, problemResponse, redirectResponse } from './http';
import type { BffFieldError, BffProblemCode } from './http';
import { log } from './logger';
import { recordLogin } from './metrics';
import { DEFAULT_RETURN_TO, safeReturnTo } from './return-to';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';
import { hashSessionId, newSessionId } from './session/session-service';
import { IdentityProviderUnavailableError, SessionStoreUnavailableError } from './session/types';
import type {
  ClientDetails,
  DirectoryContext,
  DirectoryIdentity,
  DirectoryResult,
  LoginFailureReason,
  PendingTenantSwitch,
  SessionRecord,
} from './session/types';
import { toShellSession } from './session/view';
import {
  clearReauthCookie,
  inactiveSessionResponse,
  reauthenticationRequested,
} from './session-responses';

/*
 * Rotas de sessão do BFF `/api/auth/*` (authentication.md §3/§7/§15 · US-087/US-088): login OIDC
 * com PKCE e transação cifrada, callback (troca do código, `id_token`, identidade na API, sessão
 * nova no Redis, instituição ativa), consulta da sessão (sondagem ou *keepalive*), troca de
 * instituição, step-up e logout por POST (revogação + RP-initiated logout) e o redirecionamento
 * ao *flow* de recuperação de senha do Authentik (US-089).
 */

/** Destinos do logout (SCR-001): completo, ou só local quando o Authentik não respondeu (FA-06). */
export const LOGOUT_DONE_URL = '/entrar?motivo=saiu';
export const LOGOUT_PARTIAL_URL = '/entrar?motivo=saiu-parcial';

export const AUTH_ACTIONS = [
  'login',
  'callback',
  'session',
  'step-up',
  'logout',
  'switch-tenant',
  'forgot-password',
] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];

const METHODS: Record<AuthAction, 'GET' | 'POST'> = {
  login: 'GET',
  callback: 'GET',
  session: 'GET',
  'step-up': 'GET',
  logout: 'POST',
  'switch-tenant': 'POST',
  'forgot-password': 'GET',
};

/** Rotas sujeitas ao limite de tentativas por IP (RN-IAM-15 · RN-IAM-38). */
const RATE_LIMITED_ACTIONS: ReadonlySet<AuthAction> = new Set([
  'login',
  'callback',
  'step-up',
  'forgot-password',
]);

/** Tamanho máximo do cookie de transação (navegadores aceitam ~4 KB por cookie). */
const MAX_TRANSACTION_COOKIE_BYTES = 3_800;

/** Segundos sugeridos ao navegador quando o Redis de sessões está fora (DEC-131). */
const STORE_RETRY_AFTER_SECONDS = '5';

/** `returnTo` do SCR-102: quem foi convidado ainda não tem vínculo e volta para aceitá-lo. */
const INVITE_RETURN_PREFIX = '/convite/';

/** SCR-101 com o aviso de troca não concluída depois do *step-up* (US-093 · FA-01). */
export const SWITCH_NOT_COMPLETED_URL = '/selecionar-orgao?motivo=troca-nao-concluida';

/** *Step-up* que conclui a troca suspensa pelo MFA do destino (RN-IAM-69) e segue ao início. */
export const SWITCH_STEP_UP_URL = `/api/auth/step-up?${new URLSearchParams({
  returnTo: DEFAULT_RETURN_TO,
}).toString()}`;

/** Mensagem de V-01 da US-093 (vínculo ausente ou que não é do usuário). */
const INVALID_MEMBERSHIP_MESSAGE = 'Selecione uma instituição válida.';

interface Context {
  readonly request: Request;
  readonly url: URL;
  readonly runtime: BffRuntime;
  readonly correlationId: string;
  readonly instance: string;
  /** IP do cliente pela cadeia confiável do balanceador (A-10 · FA-09). */
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  /** IP e user-agent para a auditoria de encerramento da sessão. */
  readonly client: ClientDetails;
}

function isAuthAction(value: string): value is AuthAction {
  return (AUTH_ACTIONS as readonly string[]).includes(value);
}

/** IPv4 com o último octeto mascarado para log (DEC-138). */
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.x` : 'x';
}

export async function handleAuthRequest(
  request: Request,
  action: string,
  runtime: BffRuntime = bffRuntime(),
): Promise<Response> {
  const url = new URL(request.url);
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const clientIp = clientIpFrom(
    request.headers.get('X-Forwarded-For'),
    runtime.config.trustedProxies,
  );
  const userAgent = request.headers.get('User-Agent')?.slice(0, 512) ?? null;
  const context: Context = {
    request,
    url,
    runtime,
    correlationId,
    instance: url.pathname,
    clientIp,
    userAgent,
    client: { ip: clientIp, userAgent },
  };
  if (!isAuthAction(action)) return problemResponse('NOT_FOUND', context);
  if (request.method !== METHODS[action]) {
    return problemResponse('METHOD_NOT_ALLOWED', {
      ...context,
      headers: { Allow: METHODS[action] },
    });
  }
  try {
    if (RATE_LIMITED_ACTIONS.has(action)) {
      const limited = await rateLimited(context, action);
      if (limited) return limited;
    }
    switch (action) {
      case 'login':
        return await beginLogin(context, false);
      case 'step-up':
        return await beginStepUp(context);
      case 'callback':
        return await callback(context);
      case 'session':
        return await session(context);
      case 'logout':
        return await logout(context);
      case 'switch-tenant':
        return await switchTenant(context);
      case 'forgot-password':
        return await forgotPassword(context);
    }
  } catch (error) {
    if (error instanceof SessionStoreUnavailableError) {
      log('error', 'auth.session_store_unavailable', {
        route: `/api/auth/${action}`,
        correlationId,
      });
      return problemResponse('DEPENDENCY_UNAVAILABLE', {
        ...context,
        headers: { 'Retry-After': STORE_RETRY_AFTER_SECONDS },
      });
    }
    log('error', 'bff.unhandled_exception', {
      route: `/api/auth/${action}`,
      errorName: error instanceof Error ? error.name : 'unknown',
      correlationId,
    });
    return problemResponse('INTERNAL_ERROR', context);
  }
}

async function rateLimited(context: Context, action: AuthAction): Promise<Response | null> {
  const verdict = await context.runtime.authRateLimiter.check(context.clientIp);
  if (verdict.allowed) return null;
  log('warn', 'auth.rate_limited', {
    route: `/api/auth/${action}`,
    ip: maskIp(context.clientIp),
    correlationId: context.correlationId,
  });
  if (action !== 'forgot-password') recordLogin('RATE_LIMITED');
  return problemResponse('RATE_LIMITED', {
    ...context,
    headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
  });
}

function sessionCookieValue(context: Context): string | null {
  return readCookie(context.request.headers, context.runtime.config.sessionCookieName);
}

function readTransactions(context: Context): LoginTransaction[] {
  return openTransactions(
    context.runtime.transactionKey,
    readCookie(context.request.headers, LOGIN_TRANSACTION_COOKIE),
    context.runtime.now(),
  );
}

/** `Set-Cookie` do cookie de transação: a lista cifrada, ou a remoção quando vazia. */
function transactionCookie(context: Context, transactions: readonly LoginTransaction[]): string {
  let kept = [...transactions];
  let sealed = sealTransactions(context.runtime.transactionKey, kept);
  // Cookie grande demais (vários `returnTo` longos): descarta as transações mais antigas.
  while (sealed.length > MAX_TRANSACTION_COOKIE_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    sealed = sealTransactions(context.runtime.transactionKey, kept);
  }
  return kept.length === 0
    ? clearCookie(LOGIN_TRANSACTION_COOKIE)
    : serializeCookie(LOGIN_TRANSACTION_COOKIE, sealed, LOGIN_TRANSACTION_MAX_AGE_SECONDS);
}

function loginPage(reason: 'erro' | 'indisponivel', returnTo?: string): string {
  const query = new URLSearchParams({ motivo: reason });
  if (returnTo && returnTo !== DEFAULT_RETURN_TO) query.set('returnTo', returnTo);
  return `/entrar?${query.toString()}`;
}

/** SCR-002 com a indisponibilidade do IdP e o "Tentar novamente" (preserva `returnTo`). */
function recoveryUnavailablePage(returnTo: string | null): string {
  const query = new URLSearchParams({ motivo: 'indisponivel' });
  if (returnTo && returnTo !== DEFAULT_RETURN_TO) query.set('returnTo', returnTo);
  return `/recuperar-senha?${query.toString()}`;
}

async function beginLogin(context: Context, stepUp: boolean, hint?: string): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const requested = url.searchParams.get('returnTo');
  const accepted = safeReturnTo(requested);
  if (requested !== null && accepted === null) {
    log('warn', 'auth.return_to_rejected', { correlationId });
  }
  const returnTo = accepted ?? DEFAULT_RETURN_TO;
  // Entrada depois de uma expiração (modal "Entrar novamente" ou marca deixada pelo BFF): senha de
  // novo no Authentik, mesmo com a sessão dele ainda aberta (RN-IAM-32).
  const reauthenticate =
    !stepUp &&
    (url.searchParams.get('reauth') === '1' || reauthenticationRequested(context.request.headers));
  let start;
  try {
    start = await runtime.identity.beginLogin({
      appOrigin: runtime.config.appOrigin,
      stepUp,
      hint: hint ?? url.searchParams.get('as'),
      reauthenticate,
    });
  } catch (error) {
    // Authentik fora do ar (descoberta) ou cliente não configurado: SCR-001 "indisponível".
    log('error', 'auth.login_unavailable', {
      errorName: error instanceof Error ? error.name : 'unknown',
      correlationId,
    });
    return redirectResponse(loginPage('indisponivel', returnTo), { correlationId });
  }
  log('info', 'auth.login_started', {
    returnToAccepted: accepted !== null,
    stepUp,
    reauthenticate,
    ip: maskIp(context.clientIp),
    correlationId,
  });
  const transactions = addTransaction(readTransactions(context), {
    state: start.state,
    nonce: start.nonce,
    codeVerifier: start.codeVerifier,
    returnTo,
    stepUp,
    createdAt: runtime.now(),
  });
  const headers = new Headers();
  headers.append('Set-Cookie', transactionCookie(context, transactions));
  // O destino guardado por uma recuperação de senha já foi para esta transação (FA-05 da US-089).
  if (readCookie(context.request.headers, RECOVERY_RETURN_COOKIE)) {
    headers.append('Set-Cookie', clearCookie(RECOVERY_RETURN_COOKIE));
  }
  return redirectResponse(start.redirectUrl, { correlationId, headers });
}

async function beginStepUp(context: Context): Promise<Response> {
  const lookup = await context.runtime.sessions.lookup(sessionCookieValue(context), context.client);
  // Sem sessão, step-up vira login completo preservando o destino.
  if (lookup.status !== 'active') return beginLogin(context, false);
  return beginLogin(context, true, lookup.record.subject);
}

/** Recusa no callback: nenhuma sessão, log `warn auth.callback_rejected` e volta a SCR-001. */
function rejectCallback(
  context: Context,
  headers: Headers,
  reason: LoginFailureReason | 'USER_BLOCKED' | 'NO_MEMBERSHIP' | 'DIRECTORY_UNAVAILABLE',
  location: string,
  started: number,
): Response {
  log('warn', 'auth.callback_rejected', { reason, correlationId: context.correlationId });
  recordLogin(reason, context.runtime.now() - started);
  return redirectResponse(location, { correlationId: context.correlationId, headers });
}

/** Destino da recusa da identidade pela API (FA-02/FA-06 · falha de banco). */
function identityRejection(
  result: Exclude<DirectoryResult, { kind: 'ok' }>,
  context: Context,
  returnTo: string,
): {
  reason: 'USER_BLOCKED' | 'NO_MEMBERSHIP' | 'DIRECTORY_UNAVAILABLE' | 'TOKEN_INVALID';
  location: string;
} {
  switch (result.kind) {
    case 'blocked':
      return { reason: 'USER_BLOCKED', location: '/erro/acesso-bloqueado' };
    case 'no_membership':
    case 'tenant_unavailable':
      return { reason: 'NO_MEMBERSHIP', location: '/erro/sem-vinculo' };
    case 'unauthenticated':
      return { reason: 'TOKEN_INVALID', location: loginPage('erro') };
    // Respostas que o início de sessão não produz: falha de integração.
    case 'mfa_required':
    case 'invalid_reference':
    case 'unavailable': {
      const query = new URLSearchParams({ codigo: context.correlationId, retorno: returnTo });
      return { reason: 'DIRECTORY_UNAVAILABLE', location: `/erro/manutencao?${query.toString()}` };
    }
  }
}

/** RN-IAM-09: 1 vínculo utilizável → automática; vários → a padrão, se utilizável; senão, nenhuma. */
export function selectTenant(
  identity: Pick<DirectoryIdentity, 'memberships' | 'defaultTenantId'>,
): { readonly tenantId: string; readonly selection: 'AUTO' | 'DEFAULT' } | null {
  const usable = identity.memberships.filter((membership) => membership.usable);
  const [only] = usable;
  if (usable.length === 1 && only) return { tenantId: only.tenant.id, selection: 'AUTO' };
  const preferred = usable.find((membership) => membership.tenant.id === identity.defaultTenantId);
  return preferred ? { tenantId: preferred.tenant.id, selection: 'DEFAULT' } : null;
}

async function callback(context: Context): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const { config, sessions } = runtime;
  const started = runtime.now();

  // Transação de uso único pelo `state` (login CSRF e reenvio do callback — RN-IAM-02/14).
  const { transaction, rest } = takeTransaction(
    readTransactions(context),
    url.searchParams.get('state'),
  );
  const headers = new Headers();
  headers.append('Set-Cookie', transactionCookie(context, rest));
  if (!transaction) {
    return rejectCallback(context, headers, 'STATE_MISMATCH', loginPage('erro'), started);
  }

  const completion = await runtime.identity.completeLogin(url.searchParams, transaction);
  if (!completion.ok) {
    if (completion.reason === 'PROVIDER_UNAVAILABLE') {
      const detail =
        runtime.identity instanceof OidcIdentityProvider ? runtime.identity.lastFailure : null;
      log('error', 'auth.token_exchange_failed', {
        providerStatus: detail?.providerStatus ?? null,
        correlationId,
      });
    }
    const unavailable = completion.reason === 'PROVIDER_UNAVAILABLE';
    return rejectCallback(
      context,
      headers,
      completion.reason,
      loginPage(
        unavailable ? 'indisponivel' : 'erro',
        unavailable ? transaction.returnTo : undefined,
      ),
      started,
    );
  }
  const { login } = completion;

  const current = await sessions.lookup(sessionCookieValue(context), context.client);
  if (
    transaction.stepUp &&
    current.status === 'active' &&
    current.record.subject === login.subject
  ) {
    const updated = await sessions.replaceTokens(current.record, login);
    // Troca de instituição que esperava este *step-up* (RN-IAM-69 · US-093).
    const pending = sessions.pendingTenantSwitch(updated);
    if (pending) {
      const location = await completePendingSwitch(context, updated, pending, transaction.returnTo);
      return redirectResponse(location, { correlationId, headers });
    }
    if (updated.pendingTenantSwitch) await sessions.clearPendingTenantSwitch(updated);
    return redirectResponse(transaction.returnTo, { correlationId, headers });
  }

  // Sessão nova a cada login (anti-fixação — RN-IAM-10); o hash vai para a auditoria.
  const sessionId = newSessionId();
  const directoryContext: DirectoryContext = {
    accessToken: login.tokens.accessToken,
    sessionIdHash: hashSessionId(sessionId),
    ip: context.clientIp,
    userAgent: context.userAgent,
    correlationId,
  };
  const identity = await runtime.directory.startSession(directoryContext);
  if (identity.kind !== 'ok') {
    const rejection = identityRejection(identity, context, transaction.returnTo);
    if (identity.kind === 'unavailable') {
      // A causa (status/código ou erro de rede) e o endereço usado (spec-486).
      log('error', 'auth.directory_unavailable', { ...identity.cause, correlationId });
    }
    return rejectCallback(context, headers, rejection.reason, rejection.location, started);
  }

  // Novo login no mesmo navegador encerra a sessão anterior (anti-fixação), como um logout.
  if (current.status === 'active') {
    await sessions.end(current.record, 'LOGOUT', { client: context.client });
  }
  let record: SessionRecord;
  try {
    const created = await sessions.create(sessionId, {
      login,
      user: identity.user,
      firstLogin: identity.firstLogin,
      memberships: identity.memberships,
      ip: context.clientIp,
      userAgent: context.userAgent,
    });
    record = created.record;
    if (created.evicted.length > 0) {
      log('info', 'auth.session_evicted', {
        userId: record.userId,
        count: created.evicted.length,
        correlationId,
      });
    }
  } catch (error) {
    if (!(error instanceof SessionStoreUnavailableError)) throw error;
    // Redis de sessões fora: 503 sem cookie de sessão (DEC-131).
    log('error', 'auth.session_store_unavailable', { route: '/api/auth/callback', correlationId });
    recordLogin('SESSION_STORE_UNAVAILABLE', runtime.now() - started);
    headers.set('Retry-After', STORE_RETRY_AFTER_SECONDS);
    return problemResponse('DEPENDENCY_UNAVAILABLE', { ...context, headers });
  }

  const choice = selectTenant(identity);
  if (choice) {
    const activation = await runtime.directory.activateTenant({
      ...directoryContext,
      tenantId: choice.tenantId,
      kind: 'start',
      selection: choice.selection,
      firstLogin: identity.firstLogin,
      fromTenantId: null,
    });
    if (activation.kind === 'ok' && activation.active) {
      record = await sessions.activateTenant(record, activation.active, activation.memberships);
    } else {
      log('warn', 'auth.tenant_activation_failed', {
        ...(activation.kind === 'unavailable' ? activation.cause : {}),
        result: activation.kind,
        correlationId,
      });
    }
  }

  headers.append('Set-Cookie', serializeCookie(config.sessionCookieName, sessionId));
  if (reauthenticationRequested(context.request.headers)) {
    headers.append('Set-Cookie', clearReauthCookie());
  }
  const durationMs = runtime.now() - started;
  log('info', 'auth.session_created', {
    userId: record.userId,
    tenantId: record.activeTenantId,
    selection: record.activeTenantId ? (choice?.selection ?? null) : null,
    firstLogin: record.firstLogin,
    sessionIdHashPrefix: record.key.slice(0, 8),
    durationMs,
    correlationId,
  });
  recordLogin(record.activeTenantId ? 'SUCCESS' : 'SUCCESS_WITHOUT_TENANT', durationMs);

  const usable = record.memberships.some((membership) => membership.usable);
  const destination = record.activeTenantId
    ? transaction.returnTo
    : usable
      ? `/selecionar-orgao?${new URLSearchParams({ returnTo: transaction.returnTo }).toString()}`
      : transaction.returnTo.startsWith(INVITE_RETURN_PREFIX)
        ? // US-091: a pessoa convidada ainda não tem vínculo ativo; o aceite do convite cria um.
          transaction.returnTo
        : '/erro/sem-vinculo';
  return redirectResponse(destination, { correlationId, headers });
}

/** `keepalive=true` ("Continuar conectado"); aceita também `1`. */
function isKeepalive(url: URL): boolean {
  const value = url.searchParams.get('keepalive');
  return value === 'true' || value === '1';
}

async function session(context: Context): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const lookup = await runtime.sessions.lookup(sessionCookieValue(context), context.client);
  if (lookup.status !== 'active') {
    return inactiveSessionResponse(lookup, context, runtime.config.sessionCookieName);
  }
  // Sem `keepalive`, é a sondagem do contador do shell e do foco da janela: não renova a
  // ociosidade. "Continuar conectado" renova — nunca além da duração absoluta (RN-IAM-21/22).
  const record = isKeepalive(url) ? await runtime.sessions.touch(lookup.record) : lookup.record;
  return jsonResponse({ data: toShellSession(record) }, { correlationId });
}

/**
 * Logout (RN-IAM-20): revoga o refresh token (melhor esforço, 2 s), encerra a sessão (`LOGOUT`,
 * tokens apagados, fora dos índices), expira o cookie e devolve o *RP-initiated logout* do
 * Authentik. Idempotente: sem sessão, 200 com a SCR-001. Authentik fora do ar → logout local
 * concluído e `saiu-parcial` (FA-06).
 */
async function logout(context: Context): Promise<Response> {
  const { request, runtime, correlationId } = context;
  const csrf = checkCsrf(request.method, request.headers, runtime.config.appOrigin);
  if (!csrf.ok) {
    log('warn', 'bff.csrf_rejected', {
      reason: csrf.reason,
      method: request.method,
      correlationId,
    });
    return problemResponse('CSRF_REJECTED', context);
  }
  const headers = { 'Set-Cookie': clearCookie(runtime.config.sessionCookieName) };
  const lookup = await runtime.sessions.lookup(sessionCookieValue(context), context.client);
  if (lookup.status !== 'active') {
    return jsonResponse({ data: { logoutUrl: LOGOUT_DONE_URL } }, { correlationId, headers });
  }
  const { record } = lookup;
  const revocation = await runtime.identity.revokeRefreshToken(record);
  const ended = await runtime.sessions.end(record, 'LOGOUT', { client: context.client });
  let endSessionUrl: string | null = null;
  let providerReachable = revocation !== 'unavailable';
  if (providerReachable) {
    try {
      endSessionUrl = await runtime.identity.endSessionUrl();
    } catch (error) {
      if (!(error instanceof IdentityProviderUnavailableError)) throw error;
      providerReachable = false;
    }
  }
  if (!providerReachable) {
    log('warn', 'auth.rp_logout_unavailable', { revocation, correlationId });
  }
  if (ended) {
    log('info', 'auth.logout', {
      userId: record.userId,
      tenantId: record.activeTenantId,
      rpLogout: providerReachable ? 'success' : 'partial',
      correlationId,
    });
  }
  const logoutUrl = providerReachable ? (endSessionUrl ?? LOGOUT_DONE_URL) : LOGOUT_PARTIAL_URL;
  return jsonResponse({ data: { logoutUrl } }, { correlationId, headers });
}

/**
 * "Esqueci minha senha" (US-089 · RN-IAM-34/38): rota pública que só redireciona (302) ao *flow*
 * de recuperação do Authentik. Não lê sessão, tenant, e-mail nem qualquer dado do usuário; só
 * guarda o `returnTo` validado, devolvido em `/entrar?motivo=senha-redefinida` (FA-05). IdP fora
 * do ar → SCR-002 com a mensagem de indisponibilidade e o `returnTo` preservado.
 */
async function forgotPassword(context: Context): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const requested = url.searchParams.get('returnTo');
  const returnTo = safeReturnTo(requested);
  if (requested !== null && returnTo === null) {
    log('warn', 'auth.return_to_rejected', { correlationId });
  }
  let location: string;
  try {
    location = await runtime.recovery.recoveryUrl();
  } catch (error) {
    if (!(error instanceof IdentityProviderUnavailableError)) throw error;
    log('warn', 'auth.recovery_unavailable', {
      providerStatus:
        error instanceof PasswordRecoveryUnavailableError ? error.providerStatus : null,
      correlationId,
    });
    return redirectResponse(recoveryUnavailablePage(returnTo), { correlationId });
  }
  log('info', 'auth.recovery_redirect', {
    returnToAccepted: returnTo !== null,
    ip: maskIp(context.clientIp),
    correlationId,
  });
  return redirectResponse(location, {
    correlationId,
    headers: { 'Set-Cookie': recoveryReturnCookie(returnTo) },
  });
}

/** Recusa da API na ativação de instituição → problema do BFF. */
const ACTIVATION_PROBLEMS: Readonly<
  Record<Exclude<DirectoryResult['kind'], 'ok'>, BffProblemCode>
> = {
  no_membership: 'MEMBERSHIP_INACTIVE',
  tenant_unavailable: 'TENANT_SUSPENDED',
  blocked: 'PERMISSION_DENIED',
  unauthenticated: 'SESSION_EXPIRED',
  unavailable: 'DEPENDENCY_UNAVAILABLE',
  mfa_required: 'MFA_REQUIRED',
  invalid_reference: 'VALIDATION_ERROR',
};

/** Corpo ilegível (não é JSON): 400, distinto do corpo fora do contrato (422). */
const MALFORMED_BODY = Symbol('malformed');

/** `errors[]` do 422 de `POST /api/auth/switch-tenant` (V-01 da US-093). */
function switchRequestErrors(payload: unknown, error: z.ZodError): BffFieldError[] {
  const membershipId =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).membershipId
      : undefined;
  return error.issues.map((issue) => {
    const field = String(
      (issue.code === 'unrecognized_keys' ? issue.keys[0] : issue.path[0]) ?? 'membershipId',
    );
    if (field !== 'membershipId') {
      return { field, code: 'INVALID_FORMAT', message: 'Valor inválido.' };
    }
    return {
      field,
      code: membershipId === undefined ? 'REQUIRED' : 'REFERENCE_NOT_FOUND',
      message: INVALID_MEMBERSHIP_MESSAGE,
    };
  });
}

/** Resposta de uma ativação recusada pela API (V-01/V-02 · RN-IAM-69 · Casos de erro). */
function switchRejection(
  context: Context,
  kind: Exclude<DirectoryResult['kind'], 'ok'>,
  logFields: Readonly<Record<string, unknown>>,
): Response {
  const code = ACTIVATION_PROBLEMS[kind];
  if (code !== 'DEPENDENCY_UNAVAILABLE') {
    log('warn', 'auth.tenant_switch_rejected', {
      reason: kind === 'invalid_reference' ? 'REFERENCE_NOT_FOUND' : code,
      ...logFields,
      correlationId: context.correlationId,
    });
  }
  if (kind === 'invalid_reference') {
    return problemResponse('VALIDATION_ERROR', {
      ...context,
      errors: [
        { field: 'membershipId', code: 'REFERENCE_NOT_FOUND', message: INVALID_MEMBERSHIP_MESSAGE },
      ],
    });
  }
  if (kind === 'mfa_required') {
    return problemResponse('MFA_REQUIRED', {
      ...context,
      extensions: { stepUpUrl: SWITCH_STEP_UP_URL },
    });
  }
  return problemResponse(code, context);
}

/**
 * Troca de instituição ativa (US-093 · authentication.md §6): `{ membershipId, setAsDefault? }`.
 * A API revalida o vínculo no banco e audita a troca; o BFF grava `activeTenantId`/`membershipId`
 * na MESMA sessão (`sid` e cookie mantidos — RN-IAM-66), numa escrita atômica. Dois cliques do
 * mesmo navegador são atendidos um depois do outro (o segundo vira no-op — RN-IAM-70).
 */
async function switchTenant(context: Context): Promise<Response> {
  const { request, runtime, correlationId } = context;
  const csrf = checkCsrf(request.method, request.headers, runtime.config.appOrigin);
  if (!csrf.ok) {
    log('warn', 'bff.csrf_rejected', {
      reason: csrf.reason,
      method: request.method,
      correlationId,
    });
    return problemResponse('CSRF_REJECTED', context);
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = MALFORMED_BODY;
  }
  const cookie = sessionCookieValue(context);
  const run = () => switchActiveTenant(context, cookie, payload);
  return cookie ? runtime.sessions.exclusive(hashSessionId(cookie), run) : run();
}

async function switchActiveTenant(
  context: Context,
  cookie: string | null,
  payload: unknown,
): Promise<Response> {
  const { runtime, correlationId } = context;
  const started = runtime.now();
  const cookieName = runtime.config.sessionCookieName;
  const lookup = await runtime.sessions.lookup(cookie, context.client);
  if (lookup.status !== 'active') return inactiveSessionResponse(lookup, context, cookieName);
  if (payload === MALFORMED_BODY) return problemResponse('MALFORMED_REQUEST', context);
  const parsed = switchTenantRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return problemResponse('VALIDATION_ERROR', {
      ...context,
      errors: switchRequestErrors(payload, parsed.error),
    });
  }
  const { membershipId } = parsed.data;
  const setAsDefault = parsed.data.setAsDefault === true;

  const record = lookup.record;
  const fromTenantId = record.activeTenantId;
  // Trocar para a instituição já ativa é no-op idempotente: sem API, sem auditoria (RN-IAM-70) —
  // a não ser para gravar a instituição padrão pedida (FA-04).
  if (fromTenantId !== null && record.membershipId === membershipId && !setAsDefault) {
    const touched = await runtime.sessions.touch(record);
    return jsonResponse({ data: toShellSession(touched) }, { correlationId });
  }
  const fresh = await runtime.sessions.ensureFreshToken(record, { client: context.client });
  if (fresh.status === 'expired' || fresh.status === 'ended') {
    return inactiveSessionResponse(fresh, context, cookieName);
  }
  if (fresh.status === 'unavailable') return problemResponse('DEPENDENCY_UNAVAILABLE', context);

  // A API confere o vínculo (do próprio usuário, utilizável, MFA do destino) e grava
  // `auth.session_start` (primeira escolha) ou `auth.tenant_switch`.
  const known = fresh.record.memberships.find((m) => m.membershipId === membershipId);
  const target = { membershipId, tenantId: known?.tenant.id ?? null, setAsDefault };
  const activation = await runtime.directory.activateTenant({
    ...directoryContextOf(context, fresh.record),
    ...target,
    kind: fromTenantId ? 'switch' : 'start',
    selection: 'MANUAL',
    firstLogin: fresh.record.firstLogin,
    fromTenantId,
  });
  if (activation.kind === 'mfa_required') {
    await runtime.sessions.suspendTenantSwitch(fresh.record, target);
  }
  if (activation.kind !== 'ok' || !activation.active) {
    return activation.kind === 'ok'
      ? problemResponse('DEPENDENCY_UNAVAILABLE', context)
      : switchRejection(context, activation.kind, { userId: record.userId, fromTenantId });
  }
  const updated = await runtime.sessions.activateTenant(
    fresh.record,
    activation.active,
    activation.memberships,
  );
  logTenantSwitch(updated, fromTenantId, runtime.now() - started, correlationId);
  const touched = await runtime.sessions.touch(updated);
  return jsonResponse({ data: toShellSession(touched) }, { correlationId });
}

function directoryContextOf(context: Context, record: SessionRecord): DirectoryContext {
  return {
    accessToken: record.tokens.accessToken,
    sessionIdHash: record.key,
    ip: context.clientIp,
    userAgent: context.userAgent,
    correlationId: context.correlationId,
  };
}

/** `info auth.tenant_switch` só para a troca efetiva (nunca cookie, tokens ou IP). */
function logTenantSwitch(
  record: SessionRecord,
  fromTenantId: string | null,
  durationMs: number,
  correlationId: string,
): void {
  if (record.activeTenantId === fromTenantId) return;
  log('info', 'auth.tenant_switch', {
    userId: record.userId,
    fromTenantId,
    toTenantId: record.activeTenantId,
    durationMs,
    correlationId,
  });
}

/**
 * Retorno do *step-up* com uma troca pendente (FA-01 da US-093): a API revalida com o token novo
 * (agora com MFA) e a troca se completa; recusada (vínculo encerrado no meio, MFA ainda
 * insuficiente, API fora), a sessão fica na instituição anterior e SCR-101 mostra o aviso.
 */
async function completePendingSwitch(
  context: Context,
  record: SessionRecord,
  pending: PendingTenantSwitch,
  returnTo: string,
): Promise<string> {
  const { runtime, correlationId } = context;
  const started = runtime.now();
  const fromTenantId = record.activeTenantId;
  const activation = await runtime.directory.activateTenant({
    ...directoryContextOf(context, record),
    tenantId: pending.tenantId,
    membershipId: pending.membershipId,
    setAsDefault: pending.setAsDefault,
    kind: fromTenantId ? 'switch' : 'start',
    selection: 'MANUAL',
    firstLogin: record.firstLogin,
    fromTenantId,
  });
  if (activation.kind === 'ok' && activation.active) {
    const updated = await runtime.sessions.activateTenant(
      record,
      activation.active,
      activation.memberships,
    );
    logTenantSwitch(updated, fromTenantId, runtime.now() - started, correlationId);
    return returnTo;
  }
  await runtime.sessions.clearPendingTenantSwitch(record);
  log('warn', 'auth.tenant_switch_rejected', {
    reason: activation.kind === 'ok' ? 'unavailable' : activation.kind,
    afterStepUp: true,
    userId: record.userId,
    fromTenantId,
    correlationId,
  });
  return SWITCH_NOT_COMPLETED_URL;
}
