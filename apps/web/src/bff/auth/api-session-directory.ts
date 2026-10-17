import 'server-only';

import { sessionEventResponseSchema } from '@contrataflow/validation';
import type { SessionEventRequest, SessionEventResult } from '@contrataflow/validation';

import { CORRELATION_HEADER } from '../correlation';
import type {
  DirectoryContext,
  DirectoryFailureCause,
  DirectoryResult,
  MembershipSummary,
  SessionDirectory,
  TenantActivation,
} from '../session/types';
import { SESSION_HASH_HEADER } from '../upstream';

/*
 * A API como diretório de identidade do BFF (US-087 · Lacuna 1): `POST /internal/session-events`
 * pela rede privada, com o access token do usuário e a credencial de serviço do BFF. A rota fica
 * fora de `/api/v1` — o proxy do navegador nunca a alcança.
 */

export const SESSION_EVENTS_PATH = '/internal/session-events';
export const SERVICE_TOKEN_HEADER = 'X-CF-Service-Token';

/**
 * Esperas entre tentativas quando a conexão é recusada (spec-486): a API reiniciando (deploy ou
 * `--watch` local) fecha a porta por alguns segundos. A requisição não chegou a sair, então
 * repetir é seguro; timeout e respostas HTTP nunca são repetidos.
 */
export const CONNECTION_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 1_500];

export interface ApiSessionDirectoryOptions {
  readonly apiInternalUrl: string;
  readonly serviceToken: string | null;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

function toMemberships(result: SessionEventResult): MembershipSummary[] {
  return result.memberships.map((membership) => ({
    membershipId: membership.membershipId,
    tenant: {
      id: membership.tenant.id,
      name: membership.tenant.name,
      status: membership.tenant.status,
      timezone: membership.tenant.timezone,
      // Tema da instituição (branding) chega com as configurações do tenant (US-103).
      primaryColor: null,
    },
    type: membership.type,
    status: membership.status,
    expiresAt: membership.expiresAt,
    usable: membership.usable,
    readOnly: membership.readOnly,
  }));
}

interface ProblemSummary {
  readonly code: unknown;
  readonly reason: unknown;
  /** Códigos de `errors[]` (422 de validação). */
  readonly fieldCodes: readonly unknown[];
}

async function problemOf(response: Response): Promise<ProblemSummary> {
  try {
    const body = (await response.json()) as {
      code?: unknown;
      reason?: unknown;
      errors?: unknown;
    } | null;
    const errors = Array.isArray(body?.errors) ? (body.errors as { code?: unknown }[]) : [];
    return {
      code: body?.code,
      reason: body?.reason,
      fieldCodes: errors.map((error) => error.code),
    };
  } catch {
    return { code: null, reason: null, fieldCodes: [] };
  }
}

function codeOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
    return value.code;
  }
  return null;
}

/** Código e mensagem de uma falha do `fetch` (o undici põe o erro de socket em `cause`). */
function networkFailure(error: unknown): { code: string | null; error: string | null } {
  if (!(error instanceof Error)) return { code: null, error: null };
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return { code: 'TIMEOUT', error: error.message };
  }
  const cause: unknown = error.cause;
  // Com `autoSelectFamily`, a recusa chega como AggregateError (uma por endereço tentado).
  const nested = cause instanceof AggregateError ? (cause.errors as unknown[])[0] : undefined;
  const code = codeOf(cause) ?? codeOf(nested) ?? codeOf(error);
  const message = cause instanceof Error && cause.message ? cause.message : error.message;
  return { code, error: message };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class ApiSessionDirectory implements SessionDirectory {
  constructor(private readonly options: ApiSessionDirectoryOptions) {}

  startSession(input: DirectoryContext): Promise<DirectoryResult> {
    return this.send(input, {
      type: 'SESSION_STARTED',
      sessionIdHash: input.sessionIdHash,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  activateTenant(input: TenantActivation): Promise<DirectoryResult> {
    return this.send(input, {
      type: input.kind === 'start' ? 'SESSION_STARTED' : 'TENANT_SWITCHED',
      sessionIdHash: input.sessionIdHash,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.membershipId ? { membershipId: input.membershipId } : {}),
      ...(input.setAsDefault ? { setAsDefault: true } : {}),
      selection: input.selection,
      firstLogin: input.firstLogin,
      fromTenantId: input.fromTenantId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  private unavailable(
    attempts: number,
    failure: Omit<DirectoryFailureCause, 'apiInternalUrl' | 'attempts'>,
  ): DirectoryResult {
    return {
      kind: 'unavailable',
      cause: { apiInternalUrl: this.options.apiInternalUrl, attempts, ...failure },
    };
  }

  private async send(
    context: DirectoryContext,
    body: SessionEventRequest,
  ): Promise<DirectoryResult> {
    const headers = new Headers({
      authorization: `Bearer ${context.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      [CORRELATION_HEADER]: context.correlationId,
    });
    if (this.options.serviceToken) headers.set(SERVICE_TOKEN_HEADER, this.options.serviceToken);
    // O mesmo endereço do corpo nos cabeçalhos: a API audita negações (403) pelo contexto (US-073).
    if (context.ip) headers.set('X-Forwarded-For', context.ip);
    if (context.userAgent) headers.set('User-Agent', context.userAgent.slice(0, 512));
    headers.set(SESSION_HASH_HEADER, context.sessionIdHash);
    const delays = this.options.retryDelaysMs ?? CONNECTION_RETRY_DELAYS_MS;
    const sleep = this.options.sleep ?? defaultSleep;
    let attempts = 0;
    let response: Response | null = null;
    while (!response) {
      attempts += 1;
      try {
        response = await this.options.fetch(
          `${this.options.apiInternalUrl}${SESSION_EVENTS_PATH}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'manual',
            cache: 'no-store',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
          },
        );
      } catch (error) {
        const failure = networkFailure(error);
        const delay = delays[attempts - 1];
        if (failure.code !== 'ECONNREFUSED' || delay === undefined) {
          return this.unavailable(attempts, { status: null, ...failure });
        }
        await sleep(delay);
      }
    }

    if (response.ok) {
      const parsed = sessionEventResponseSchema.safeParse(
        ((await response.json().catch(() => null)) as { data?: unknown } | null)?.data,
      );
      if (!parsed.success) {
        return this.unavailable(attempts, {
          status: response.status,
          code: 'CONTRACT_MISMATCH',
          error: null,
        });
      }
      // Troca suspensa pelo MFA da instituição de destino (RN-IAM-69 · US-093).
      if (parsed.data.mfaRequired) return { kind: 'mfa_required' };
      return {
        kind: 'ok',
        user: parsed.data.user,
        firstLogin: parsed.data.firstLogin,
        memberships: toMemberships(parsed.data),
        active: parsed.data.activeMembership,
        defaultTenantId: parsed.data.defaultTenantId ?? null,
      };
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return { kind: 'unauthenticated' };
    }
    const { status } = response;
    const { code, reason, fieldCodes } = await problemOf(response);
    const failed = () =>
      this.unavailable(attempts, {
        status,
        code: typeof code === 'string' ? code : null,
        error: null,
      });
    if (status === 403) {
      // Só o bloqueio do usuário: outro 403 (ex.: credencial de serviço) é falha de integração.
      if (code === 'PERMISSION_DENIED' && reason === 'USER_BLOCKED') return { kind: 'blocked' };
      if (code === 'TENANT_SUSPENDED') return { kind: 'tenant_unavailable' };
      if (code === 'MEMBERSHIP_INACTIVE') return { kind: 'no_membership' };
      return failed();
    }
    // Vínculo que não é do usuário (V-01 da US-093); outro 422 é falha de integração.
    if (
      status === 422 &&
      code === 'VALIDATION_ERROR' &&
      fieldCodes.includes('REFERENCE_NOT_FOUND')
    ) {
      return { kind: 'invalid_reference' };
    }
    return failed();
  }
}
