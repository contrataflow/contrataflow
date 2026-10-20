import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { inboxViewerOf } from '../domain/task-inbox.js';
import type { InboxViewer } from '../domain/task-inbox.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/**
 * Quem consulta a caixa (US-056), resolvido uma vez por requisição no `tx` da leitura: permissões
 * efetivas (visibilidade DEC-024, `PROCESS_CLAIM`, lotações e chefias — US-097), titularidades e
 * substituições (`organization`, POL-03), a cobertura dos perfis aprovadores (`access`) e
 * `access.historicalDepartmentsCanView`.
 */
@Injectable()
export class InboxViewerResolver {
  constructor(
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  async resolveIn(tx: TenantTx, now: Date): Promise<InboxViewer> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const permissions = await this.access.effectivePermissions();
    // Em sequência: a transação interativa executa uma consulta por vez.
    const leadership = await this.organization.departmentLeadership(tx, userId);
    const roles = await this.access.approverCompetenceIn(tx, now);
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    const claim = permissions.has('PROCESS_CLAIM')
      ? permissions.processScopeOf('PROCESS_CLAIM')
      : null;
    return inboxViewerOf({
      userId,
      ownDepartmentIds: permissions.snapshot.ownDepartmentIds,
      headOfDepartmentIds: permissions.snapshot.headOfDepartmentIds,
      claim:
        claim === null
          ? null
          : {
              tenantWide: claim.tenantWide,
              organizationIds: claim.organizationIds,
              departmentIds: claim.departmentIds,
            },
      leadership,
      roles,
      visibility: permissions.visibilityScope(),
      historicalDepartmentsCanView: settings.get(HISTORICAL_SETTING) !== false,
    });
  }
}
