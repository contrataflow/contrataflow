import 'server-only';

import { sessionEventResponseSchema } from '@contrataflow/validation';
import type { SessionEventRequest, SessionEventResult } from '@contrataflow/validation';

import { CORRELATION_HEADER } from '../correlation';
import type {
  DirectoryContext,
  DirectoryResult,
  MembershipSummary,
  SessionDirectory,
  TenantActivation,
} from '../session/types';

/*
 * A API como diretório de identidade do BFF (US-087 · Lacuna 1): `POST /internal/session-events`
 * pela rede privada, com o access token do usuário e a credencial de serviço do BFF. A rota fica
 * fora de `/api/v1` — o proxy do navegador nunca a alcança.
 */

export const SESSION_EVENTS_PATH = '/internal/session-events';
export const SERVICE_TOKEN_HEADER = 'X-CF-Service-Token';

export interface ApiSessionDirectoryOptions {
  readonly apiInternalUrl: string;
  readonly serviceToken: string | null;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
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

async function problemOf(response: Response): Promise<{ code: unknown; reason: unknown }> {
  try {
    const body = (await response.json()) as { code?: unknown; reason?: unknown } | null;
    return { code: body?.code, reason: body?.reason };
  } catch {
    return { code: null, reason: null };
  }
}

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
      tenantId: input.tenantId,
      selection: input.selection,
      firstLogin: input.firstLogin,
      fromTenantId: input.fromTenantId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
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
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.apiInternalUrl}${SESSION_EVENTS_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      return { kind: 'unavailable' };
    }

    if (response.ok) {
      const parsed = sessionEventResponseSchema.safeParse(
        ((await response.json().catch(() => null)) as { data?: unknown } | null)?.data,
      );
      if (!parsed.success) return { kind: 'unavailable' };
      return {
        kind: 'ok',
        user: parsed.data.user,
        firstLogin: parsed.data.firstLogin,
        memberships: toMemberships(parsed.data),
        active: parsed.data.activeMembership,
        // Instituição padrão do usuário (RN-IAM-09) chega com a US-093.
        defaultTenantId: null,
      };
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return { kind: 'unauthenticated' };
    }
    if (response.status === 403) {
      const { code, reason } = await problemOf(response);
      // Só o bloqueio do usuário: outro 403 (ex.: credencial de serviço) é falha de integração.
      if (code === 'PERMISSION_DENIED' && reason === 'USER_BLOCKED') return { kind: 'blocked' };
      if (code === 'TENANT_SUSPENDED') return { kind: 'tenant_unavailable' };
      if (code === 'MEMBERSHIP_INACTIVE') return { kind: 'no_membership' };
      return { kind: 'unavailable' };
    }
    await response.body?.cancel();
    return { kind: 'unavailable' };
  }
}
