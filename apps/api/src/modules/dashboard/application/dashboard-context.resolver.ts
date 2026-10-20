import { addCalendarDays, localDateOf } from '@contrataflow/types';
import { DASHBOARD_MESSAGES, SECRETARIAT_TYPES } from '@contrataflow/validation';
import type { DashboardFilters, FieldError } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { DashboardViewer } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { DepartmentReference } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { dashboardWindowOf, NO_SCOPE } from '../domain/dashboard.js';
import type { DashboardScope, DashboardWindow } from '../domain/dashboard.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';
const WARN_SETTING = 'deadlines.warnBeforeBusinessDays';
const DEFAULT_WARN_BUSINESS_DAYS = 2;

/**
 * O contexto de uma consulta do painel (US-076), resolvido no `tx` da leitura: os filtros
 * validados e expandidos (V-02/V-03 · RN-DASH-09), quem consulta (visibilidade DEC-024 e POL-09) e
 * os instantes de referência no fuso do tenant (prazo "a vencer", janela de 90 dias, 12 meses).
 */
@Injectable()
export class DashboardContextResolver {
  constructor(
    private readonly access: AccessFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly calendar: BusinessCalendarFacade,
  ) {}

  /**
   * V-02/V-03: inexistente ou de outro tenant = `REFERENCE_NOT_FOUND` (indistinguíveis — nunca
   * revela outro tenant); inativa = `REFERENCE_INACTIVE`; secretaria que não é `SECRETARIAT`/`BOARD`
   * nem raiz = `NOT_ALLOWED`; setor fora da subárvore = `DEPARTMENT_NOT_IN_SECRETARIAT`. Válidos,
   * viram o recorte (o setor com a sua subárvore).
   */
  async scopeOf(tx: TenantTx, filters: DashboardFilters): Promise<DashboardScope> {
    const { secretariatId, departmentId } = filters;
    if (secretariatId === undefined && departmentId === undefined) return NO_SCOPE;
    const ids = [secretariatId, departmentId].filter((id): id is string => id !== undefined);
    const references = await this.organization.departmentReferences(tx, ids);
    const secretariat = secretariatId === undefined ? undefined : references.get(secretariatId);
    const department = departmentId === undefined ? undefined : references.get(departmentId);
    const errors: FieldError[] = [];
    if (secretariatId !== undefined) {
      const issue = unitIssue(secretariat);
      if (issue !== null) errors.push({ field: 'secretariatId', ...issue });
      else if (!isSecretariatOption(secretariat)) {
        errors.push({
          field: 'secretariatId',
          code: 'NOT_ALLOWED',
          message: DASHBOARD_MESSAGES.invalidUnit,
        });
      }
    }
    if (departmentId !== undefined) {
      const issue = unitIssue(department);
      if (issue !== null) errors.push({ field: 'departmentId', ...issue });
    }
    if (
      errors.length === 0 &&
      secretariat !== undefined &&
      department !== undefined &&
      department.id !== secretariat.id &&
      !department.path.startsWith(secretariat.path)
    ) {
      errors.push({
        field: 'departmentId',
        code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
        message: DASHBOARD_MESSAGES.departmentNotInSecretariat,
      });
    }
    if (errors.length > 0) throw validationError(errors);
    return {
      secretariatId: secretariatId ?? null,
      departmentIds:
        departmentId === undefined
          ? null
          : await this.organization.subtreeDepartmentIds(tx, departmentId),
    };
  }

  /** Quem consulta: visibilidade (DEC-024), POL-09 (com o MFA exigido) e as unidades históricas. */
  async viewerIn(tx: TenantTx): Promise<DashboardViewer> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const permissions = await this.access.effectivePermissions();
    const budget = await this.access.confidentialBudgetAccess();
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    return {
      userId,
      visibility: permissions.visibilityScope(),
      historicalDepartmentsCanView: settings.get(HISTORICAL_SETTING) !== false,
      budget: { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
    };
  }

  /** Fuso, `deadlines.warnBeforeBusinessDays` e os próximos dias úteis (uma leitura de feriados). */
  async windowIn(tx: TenantTx, now: Date): Promise<DashboardWindow> {
    const settings = await this.tenancy.settingValues(tx, [WARN_SETTING]);
    const configured = settings.get(WARN_SETTING);
    const warn =
      typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_WARN_BUSINESS_DAYS;
    const timezone = await this.calendar.timezone(tx);
    const today = localDateOf(now, timezone);
    // Folga: no pior caso 5 dias úteis a cada 7 corridos, mais um mês de feriados.
    const businessDaysAfterToday = await this.calendar.listBusinessDaysBetween(
      tx,
      addCalendarDays(today, 1),
      addCalendarDays(today, (warn + 1) * 2 + 31),
    );
    return dashboardWindowOf({
      now,
      timezone,
      warnBeforeBusinessDays: warn,
      businessDaysAfterToday,
    });
  }
}

/** RN-PROC-02: `SECRETARIAT`/`BOARD` ou raiz do órgão. */
function isSecretariatOption(unit: DepartmentReference | undefined): boolean {
  return unit !== undefined && (unit.parentId === null || SECRETARIAT_TYPES.includes(unit.type));
}

function unitIssue(
  unit: DepartmentReference | undefined,
): Pick<FieldError, 'code' | 'message'> | null {
  if (unit === undefined) {
    return { code: 'REFERENCE_NOT_FOUND', message: DASHBOARD_MESSAGES.invalidUnit };
  }
  if (!unit.isActive) {
    return { code: 'REFERENCE_INACTIVE', message: DASHBOARD_MESSAGES.invalidUnit };
  }
  return null;
}
