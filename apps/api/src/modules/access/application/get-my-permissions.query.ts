import type { MyPermissionsDto } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { AuthorizationService } from './authorization.service.js';

/** `GetMyPermissionsQuery` — ME-03 (sem parâmetros: o vínculo é o da requisição). */
export type GetMyPermissionsQuery = Record<string, never>;

/**
 * `GetMyPermissionsHandler` — ME-03 `GET /me/permissions` (US-097 · RN-IAM-106 · permissions.md
 * §9): as permissões efetivas do vínculo ativo, por escopo, e as capacidades implícitas (§7). Capacidade
 * implícita (vínculo ativo); somente leitura, sem auditoria. Servida do mesmo retrato que o
 * `AuthorizationGuard` acabou de carregar — cache quente, sem banco.
 */
@Injectable()
export class GetMyPermissionsHandler {
  constructor(private readonly authorization: AuthorizationService) {}

  async execute(_query: GetMyPermissionsQuery = {}): Promise<MyPermissionsDto> {
    return (await this.authorization.current()).toMyPermissions();
  }
}
