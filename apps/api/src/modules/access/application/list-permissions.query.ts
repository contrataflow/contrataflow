import { PERMISSIONS } from '@contrataflow/types';
import { permissionFilters } from '@contrataflow/validation';
import type { PermissionDto, PermissionListQuery } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { AccessFacade } from './access.facade.js';

/**
 * `ListPermissionsQuery` — ROL-01 (US-094 · RN-IAM-78): catálogo GLOBAL de permissões (o mesmo
 * para todos os tenants), somente leitura, com filtros opcionais `module` e `riskLevel` (valor
 * desconhecido é ignorado — `permissionFilters`). Exige `ROLE_VIEW` (risco baixo, sem MFA). Servido da
 * constante em código — a mesma que a migração sincroniza com a tabela `permissions` —, sem banco
 * nem Redis no caminho.
 */
@Injectable()
export class ListPermissionsQuery {
  constructor(private readonly access: AccessFacade) {}

  execute(query: PermissionListQuery): PermissionDto[] {
    this.access.assertCan('ROLE_VIEW', { mfaPolicy: 'NONE' });
    const { module, riskLevel } = permissionFilters(query);
    return PERMISSIONS.filter(
      (permission) =>
        (module === undefined || permission.module === module) &&
        (riskLevel === undefined || permission.riskLevel === riskLevel),
    ).map((permission) => ({ ...permission }));
  }
}
