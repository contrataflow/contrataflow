import { Logger } from '@nestjs/common';

import { AuthentikUnavailableError } from '../application/invitation-ports.js';
import type { AuthentikProvisioningPort } from '../application/invitation-ports.js';
import type {
  AuthentikAccountRef,
  AuthentikDirectoryPort,
  AuthentikMfaPort,
} from '../application/ports.js';

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
/**
 * Tipos de dispositivo de MFA da API administrativa (`/authenticators/admin/<tipo>/`): os métodos
 * aceitos (TOTP e WebAuthn — DEC-133) e os de recuperação que também satisfazem o desafio.
 */
export const AUTHENTIK_MFA_DEVICE_TYPES = ['totp', 'webauthn', 'static', 'duo', 'sms'] as const;

export class AuthentikAdminClient
  implements AuthentikDirectoryPort, AuthentikProvisioningPort, AuthentikMfaPort
{
  private readonly logger = new Logger('Identity');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: AuthentikAdminOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private url(path: string): URL {
    const base = this.options.apiUrl.endsWith('/')
      ? this.options.apiUrl
      : `${this.options.apiUrl}/`;
    return new URL(path, base);
  }

  private request(url: URL, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return this.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
  }

  /**
   * Convite (US-091 · RN-IAM-46 · DEC-130): cria a conta SEM senha — a pessoa a define no próprio
   * Authentik (fluxo de recuperação/definição de senha). E-mail já cadastrado no Authentik (conta
   * criada antes, fora do ContrataFlow) → reaproveita a conta existente (`created = false`).
   */
  async provisionUser(user: {
    email: string;
    name: string;
  }): Promise<{ pk: string; created: boolean }> {
    try {
      const existing = await this.findPkByEmail(user.email);
      if (existing !== null) return { pk: existing, created: false };
      const response = await this.request(this.url('core/users/'), {
        method: 'POST',
        body: {
          username: user.email,
          email: user.email,
          name: user.name,
          is_active: true,
          path: 'users',
          type: 'internal',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = (await response.json()) as { pk?: unknown };
      if (typeof body.pk !== 'number' && typeof body.pk !== 'string') {
        throw new Error('Resposta sem pk');
      }
      return { pk: String(body.pk), created: true };
    } catch (error) {
      throw new AuthentikUnavailableError({ cause: error });
    }
  }

  /** Compensação do convite que não chegou ao commit: melhor esforço, nunca lança. */
  async removeUser(pk: string): Promise<void> {
    if (!/^\d+$/.test(pk)) return;
    try {
      const response = await this.request(this.url(`core/users/${pk}/`), { method: 'DELETE' });
      if (!response.ok && response.status !== 404)
        throw new Error(`HTTP ${String(response.status)}`);
      this.logger.warn(
        { event: 'identity.authentik_user_compensated' },
        'identity.authentik_user_compensated',
      );
    } catch (error) {
      this.logger.error(
        {
          event: 'identity.authentik_compensation_failed',
          alert: true,
          authentikUserId: pk,
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'identity.authentik_compensation_failed',
      );
    }
  }

  /**
   * US-090 · USR-13: lista e remove os dispositivos de cada tipo da conta (`?user=<pk>`); 404 na
   * remoção = já removido (redefinição repetida ou concorrente). Qualquer outra falha →
   * `AuthentikUnavailableError` (o caso de uso responde 503 e a repetição é segura).
   */
  async resetMfa(account: AuthentikAccountRef): Promise<{ removedDevices: number }> {
    try {
      const pk =
        account.authentikUserId ??
        (account.externalSubject === null
          ? null
          : await this.findPkBySubjectStrict(account.externalSubject));
      // Sem conta no Authentik não há fator cadastrado: nada a remover.
      if (pk === null || !/^\d+$/.test(pk)) return { removedDevices: 0 };
      let removedDevices = 0;
      for (const type of AUTHENTIK_MFA_DEVICE_TYPES) {
        const list = this.url(`authenticators/admin/${type}/`);
        list.searchParams.set('user', pk);
        const response = await this.request(list);
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const body = (await response.json()) as { results?: { pk?: unknown }[] };
        for (const device of body.results ?? []) {
          if (typeof device.pk !== 'number' && typeof device.pk !== 'string') continue;
          const id = encodeURIComponent(String(device.pk));
          const removal = await this.request(this.url(`authenticators/admin/${type}/${id}/`), {
            method: 'DELETE',
          });
          if (!removal.ok && removal.status !== 404) {
            throw new Error(`HTTP ${String(removal.status)}`);
          }
          if (removal.ok) removedDevices += 1;
        }
      }
      return { removedDevices };
    } catch (error) {
      throw new AuthentikUnavailableError({ cause: error });
    }
  }

  /** PK pelo `sub` (UUID), propagando a falha (a redefinição não pode seguir às cegas). */
  private async findPkBySubjectStrict(subject: string): Promise<string | null> {
    if (!UUID.test(subject)) return null;
    const url = this.url('core/users/');
    url.searchParams.set('uuid', subject);
    const response = await this.request(url);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const body = (await response.json()) as { results?: { pk?: unknown; uuid?: unknown }[] };
    const match = body.results?.find((user) => user.uuid === subject);
    return typeof match?.pk === 'number' || typeof match?.pk === 'string' ? String(match.pk) : null;
  }

  private async findPkByEmail(email: string): Promise<string | null> {
    const url = this.url('core/users/');
    url.searchParams.set('email', email);
    const response = await this.request(url);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const body = (await response.json()) as { results?: { pk?: unknown; email?: unknown }[] };
    const match = body.results?.find(
      (candidate) =>
        typeof candidate.email === 'string' &&
        candidate.email.toLowerCase() === email.toLowerCase(),
    );
    return typeof match?.pk === 'number' || typeof match?.pk === 'string' ? String(match.pk) : null;
  }

  async findUserPkBySubject(subject: string): Promise<string | null> {
    if (!UUID.test(subject)) return null;
    const url = this.url('core/users/');
    url.searchParams.set('uuid', subject);
    try {
      const response = await this.request(url);
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
export class DisabledAuthentikDirectory
  implements AuthentikDirectoryPort, AuthentikProvisioningPort, AuthentikMfaPort
{
  findUserPkBySubject(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** Sem a API administrativa não há como criar a conta: o convite responde 503. */
  provisionUser(): Promise<{ pk: string; created: boolean }> {
    return Promise.reject(new AuthentikUnavailableError());
  }

  removeUser(): Promise<void> {
    return Promise.resolve();
  }

  /** Sem a API administrativa não há como remover os fatores: USR-13 responde 503. */
  resetMfa(): Promise<{ removedDevices: number }> {
    return Promise.reject(new AuthentikUnavailableError());
  }
}
