import { Logger } from '@nestjs/common';

import type { AuthentikDirectoryPort } from '../application/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthentikAdminOptions {
  /** Base da API administrativa (`https://auth.<domínio>/api/v3/`). */
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * `AuthentikAdminClient` (US-087): consulta da API administrativa do Authentik usada no primeiro
 * login para confirmar a qual usuário do Authentik pertence o `sub` (UUID — `sub_mode:
 * user_uuid`) e vinculá-lo ao `User` convidado pelo `authentikUserId` (RN-IAM-06). Falha aqui não
 * impede o login: o vínculo segue pelo e-mail verificado.
 */
export class AuthentikAdminClient implements AuthentikDirectoryPort {
  private readonly logger = new Logger('Identity');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: AuthentikAdminOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async findUserPkBySubject(subject: string): Promise<string | null> {
    if (!UUID.test(subject)) return null;
    const base = this.options.apiUrl.endsWith('/')
      ? this.options.apiUrl
      : `${this.options.apiUrl}/`;
    const url = new URL('core/users/', base);
    url.searchParams.set('uuid', subject);
    try {
      const response = await this.fetch(url, {
        headers: { authorization: `Bearer ${this.options.apiToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        this.logger.warn(
          { event: 'identity.authentik_lookup_failed', status: response.status },
          'identity.authentik_lookup_failed',
        );
        return null;
      }
      const body = (await response.json()) as { results?: { pk?: unknown; uuid?: unknown }[] };
      const match = body.results?.find((user) => user.uuid === subject);
      return typeof match?.pk === 'number' || typeof match?.pk === 'string'
        ? String(match.pk)
        : null;
    } catch (error) {
      this.logger.warn(
        {
          event: 'identity.authentik_lookup_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'identity.authentik_lookup_failed',
      );
      return null;
    }
  }
}

/** Sem integração configurada: o vínculo do primeiro login segue só pelo e-mail verificado. */
export class DisabledAuthentikDirectory implements AuthentikDirectoryPort {
  findUserPkBySubject(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
