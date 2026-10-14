// API de administração do Authentik local, autenticada com o token de bootstrap (akadmin). Só os
// scripts de ambiente a usam — a aplicação nunca usa credenciais de bootstrap (RN-FND-19).
import { portOf } from './env-file.js';
import type { EnvMap } from './env-file.js';

export interface AuthentikUser {
  readonly pk: number;
  readonly uuid: string;
  readonly username: string;
  readonly isActive: boolean;
}

export interface BlueprintStatus {
  readonly name: string;
  readonly path: string;
  /** `successful`, `warning`, `error`, `orphaned`, `unknown`. */
  readonly status: string;
  readonly enabled: boolean;
}

export interface AuthentikApi {
  readonly baseUrl: string;
  readonly usersInPath: (path: string) => Promise<AuthentikUser[]>;
  readonly blueprints: (pathPrefix: string) => Promise<BlueprintStatus[]>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function authentikBaseUrl(env: EnvMap): string {
  return `http://localhost:${portOf(env, 'AUTHENTIK_PORT')}`;
}

interface Page<T> {
  readonly results: readonly T[];
  readonly pagination?: { readonly next?: number };
}

interface RawUser {
  readonly pk: number;
  readonly uuid: string;
  readonly username: string;
  readonly is_active: boolean;
}

interface RawBlueprint {
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly enabled: boolean;
}

export function createAuthentikApi(env: EnvMap, fetchImpl: FetchLike = fetch): AuthentikApi {
  const baseUrl = authentikBaseUrl(env);
  const headers = {
    Authorization: `Bearer ${env.AUTHENTIK_BOOTSTRAP_TOKEN ?? ''}`,
    Accept: 'application/json',
  };

  async function list<T>(resource: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ ...query, page: String(page), page_size: '100' });
      const response = await fetchImpl(`${baseUrl}/api/v3/${resource}/?${params.toString()}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(`Authentik respondeu HTTP ${response.status} em /api/v3/${resource}/.`);
      }
      const body = (await response.json()) as Page<T>;
      items.push(...body.results);
      const next = body.pagination?.next ?? 0;
      if (!next) return items;
      page = next;
    }
  }

  return {
    baseUrl,
    usersInPath: async (path) =>
      (await list<RawUser>('core/users', { path })).map((user) => ({
        pk: user.pk,
        uuid: user.uuid,
        username: user.username,
        isActive: user.is_active,
      })),
    blueprints: async (pathPrefix) =>
      (await list<RawBlueprint>('managed/blueprints', {}))
        .filter((blueprint) => blueprint.path.startsWith(pathPrefix))
        .map(({ name, path, status, enabled }) => ({ name, path, status, enabled })),
  };
}

/** Pasta dos blueprints do ContrataFlow dentro do contêiner (/blueprints/contrataflow). */
export const BLUEPRINT_PATH_PREFIX = 'contrataflow/';
