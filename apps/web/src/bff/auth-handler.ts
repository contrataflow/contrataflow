import 'server-only';

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  LOGIN_TRANSACTION_COOKIE,
  LOGIN_TRANSACTION_MAX_AGE_SECONDS,
  clearCookie,
  decodeLoginTransaction,
  encodeLoginTransaction,
  readCookie,
  serializeCookie,
} from './cookies';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { checkCsrf } from './csrf';
import { jsonResponse, problemResponse, redirectResponse } from './http';
import { log } from './logger';
import { DEFAULT_RETURN_TO, safeReturnTo } from './return-to';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';
import { toShellSession } from './session/view';

/*
 * Rotas de sessão do BFF `/api/auth/*` (authentication.md §15 · architecture.md §8.4). O fluxo
 * tem a forma definitiva (transação com `state`, callback, sessão opaca, troca de tenant,
 * step-up, logout por POST); o provedor por trás é o fake (FA-06) até o OIDC da US-087.
 */

export const AUTH_ACTIONS = [
  'login',
  'callback',
  'session',
  'step-up',
  'logout',
  'switch-tenant',
] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];

const METHODS: Record<AuthAction, 'GET' | 'POST'> = {
  login: 'GET',
  callback: 'GET',
  session: 'GET',
  'step-up': 'GET',
  logout: 'POST',
  'switch-tenant': 'POST',
};

const switchTenantSchema = z.strictObject({ tenantId: z.uuid() });

interface Context {
  readonly request: Request;
  readonly url: URL;
  readonly runtime: BffRuntime;
  readonly correlationId: string;
  readonly instance: string;
}

function isAuthAction(value: string): value is AuthAction {
  return (AUTH_ACTIONS as readonly string[]).includes(value);
}

export async function handleAuthRequest(
  request: Request,
  action: string,
  runtime: BffRuntime = bffRuntime(),
): Promise<Response> {
  const url = new URL(request.url);
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const context: Context = { request, url, runtime, correlationId, instance: url.pathname };
  if (!isAuthAction(action)) return problemResponse('NOT_FOUND', context);
  if (request.method !== METHODS[action]) {
    return problemResponse('METHOD_NOT_ALLOWED', {
      ...context,
      headers: { Allow: METHODS[action] },
    });
  }
  try {
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
    }
  } catch (error) {
    log('error', 'bff.unhandled_exception', {
      route: `/api/auth/${action}`,
      errorName: error instanceof Error ? error.name : 'unknown',
      correlationId,
    });
    return problemResponse('INTERNAL_ERROR', context);
  }
}

function sessionCookieValue(context: Context): string | null {
  return readCookie(context.request.headers, context.runtime.config.sessionCookieName);
}

async function beginLogin(context: Context, stepUp: boolean, hint?: string): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const requested = url.searchParams.get('returnTo');
  const accepted = safeReturnTo(requested);
  if (requested !== null && accepted === null) {
    log('warn', 'auth.return_to_rejected', { correlationId });
  }
  const returnTo = accepted ?? DEFAULT_RETURN_TO;
  const state = randomBytes(24).toString('base64url');
  let start;
  try {
    start = await runtime.identity.beginLogin({
      appOrigin: runtime.config.appOrigin,
      state,
      stepUp,
      hint: hint ?? url.searchParams.get('as'),
    });
  } catch {
    return problemResponse('DEPENDENCY_UNAVAILABLE', context);
  }
  log('info', 'auth.login_started', { returnToAccepted: accepted !== null, stepUp, correlationId });
  const transaction = encodeLoginTransaction({ state: start.transaction, returnTo, stepUp });
  return redirectResponse(start.redirectUrl, {
    correlationId,
    headers: {
      'Set-Cookie': serializeCookie(
        LOGIN_TRANSACTION_COOKIE,
        transaction,
        LOGIN_TRANSACTION_MAX_AGE_SECONDS,
      ),
    },
  });
}

async function beginStepUp(context: Context): Promise<Response> {
  const lookup = await context.runtime.sessions.lookup(sessionCookieValue(context));
  // Sem sessão, step-up vira login completo preservando o destino.
  if (lookup.status !== 'active') return beginLogin(context, false);
  return beginLogin(context, true, lookup.record.subject);
}

async function callback(context: Context): Promise<Response> {
  const { request, url, runtime, correlationId } = context;
  const { config, sessions } = runtime;
  const transaction = decodeLoginTransaction(readCookie(request.headers, LOGIN_TRANSACTION_COOKIE));
  const completion = await runtime.identity.completeLogin(
    url.searchParams,
    transaction?.state ?? null,
  );
  const headers = new Headers({ 'Set-Cookie': clearCookie(LOGIN_TRANSACTION_COOKIE) });
  if (!completion.ok || !transaction) {
    log('warn', 'auth.callback_rejected', {
      reason: completion.ok ? 'STATE_MISMATCH' : completion.reason,
      correlationId,
    });
    return redirectResponse('/entrar?motivo=erro', { correlationId, headers });
  }

  const current = await sessions.lookup(sessionCookieValue(context));
  if (
    transaction.stepUp &&
    current.status === 'active' &&
    current.record.subject === completion.identity.subject
  ) {
    await sessions.replaceTokens(current.record, completion.identity);
    return redirectResponse(transaction.returnTo, { correlationId, headers });
  }
  // Anti-fixação: todo login gera um novo id de sessão e encerra o anterior.
  if (current.status === 'active') await sessions.destroy(current.record.key);
  const created = await sessions.create(completion.identity);
  headers.append('Set-Cookie', serializeCookie(config.sessionCookieName, created.sessionId));
  log('info', 'auth.session_created', {
    userId: created.record.userId,
    tenantId: created.record.activeTenantId,
    sessionIdHashPrefix: created.record.key.slice(0, 8),
    correlationId,
  });
  const destination = created.record.activeTenantId ? transaction.returnTo : '/selecionar-orgao';
  return redirectResponse(destination, { correlationId, headers });
}

async function session(context: Context): Promise<Response> {
  const { url, runtime, correlationId } = context;
  const lookup = await runtime.sessions.lookup(sessionCookieValue(context));
  if (lookup.status === 'none') return problemResponse('UNAUTHENTICATED', context);
  if (lookup.status === 'expired') {
    return problemResponse('SESSION_EXPIRED', {
      ...context,
      headers: { 'Set-Cookie': clearCookie(runtime.config.sessionCookieName) },
    });
  }
  // Sondagem (`keepalive=1`, foco da janela) não renova a ociosidade (RN-IAM-21).
  const record =
    url.searchParams.get('keepalive') === '1'
      ? lookup.record
      : await runtime.sessions.touch(lookup.record);
  return jsonResponse({ data: toShellSession(record) }, { correlationId });
}

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
  const lookup = await runtime.sessions.lookup(sessionCookieValue(context));
  const record = lookup.status === 'active' ? lookup.record : null;
  if (record) {
    await runtime.sessions.destroy(record.key);
    log('info', 'auth.session_end', { reason: 'LOGOUT', userId: record.userId, correlationId });
  }
  const redirectTo = runtime.identity.endSessionUrl(record) ?? '/entrar?motivo=saiu';
  return jsonResponse(
    { data: { redirectTo } },
    { correlationId, headers: { 'Set-Cookie': clearCookie(runtime.config.sessionCookieName) } },
  );
}

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
  const lookup = await runtime.sessions.lookup(sessionCookieValue(context));
  if (lookup.status === 'none') return problemResponse('UNAUTHENTICATED', context);
  if (lookup.status === 'expired') {
    return problemResponse('SESSION_EXPIRED', {
      ...context,
      headers: { 'Set-Cookie': clearCookie(runtime.config.sessionCookieName) },
    });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return problemResponse('MALFORMED_REQUEST', context);
  }
  const parsed = switchTenantSchema.safeParse(payload);
  if (!parsed.success) return problemResponse('MALFORMED_REQUEST', context);

  const fromTenantId = lookup.record.activeTenantId;
  const result = await runtime.sessions.switchTenant(lookup.record, parsed.data.tenantId);
  if (result.status === 'not_usable') return problemResponse('MEMBERSHIP_INACTIVE', context);
  if (result.status === 'switched') {
    log('info', 'auth.tenant_switch', {
      fromTenantId,
      toTenantId: parsed.data.tenantId,
      correlationId,
    });
  }
  const touched = await runtime.sessions.touch(result.record);
  return jsonResponse({ data: toShellSession(touched) }, { correlationId });
}
