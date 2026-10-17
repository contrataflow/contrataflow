import { createHash } from 'node:crypto';

import {
  RISK_MESSAGES,
  RiskAssessed,
  RiskCreated,
  RiskDeleted,
  riskLevelThresholdsSettingSchema,
  riskScaleSettingSchema,
} from '@contrataflow/validation';
import type { RiskDto, RiskScaleSnapshot } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { RISK_REPOSITORY } from './ports.js';
import type { RiskRepository, RiskTreatmentRef } from './ports.js';
import { ownerReferenceError, riskNotFound } from './risk.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  TypedCollectionState,
  TypedCollectionWrite,
} from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { Risk, RiskChange, RiskReassessment } from '../domain/risk.js';

/*
 * Peças comuns dos casos de uso de riscos (US-033): a guarda (POL-02 estendida — RN-RISK-09 — pela
 * fachada do `document`, que trava o `RISK_MAP` no `tx`), a escala vigente do tenant
 * (`risk.scale`/`risk.levelThresholds`, lidas no `tx` — FA-02), as referências (categoria ativa do
 * `RISK_CATEGORY`, usuário e unidade responsáveis — V-04/V-05), o apresentador e a gravação dos
 * efeitos na mesma transação (auditoria `risk.*` e eventos `Risk*`, que projetam a timeline).
 */

const RISK_COLLECTION = {
  systemModule: 'RISK_MAP',
  deniedDetail: RISK_MESSAGES.permissionDenied,
  lockedDetail: RISK_MESSAGES.locked,
} as const;

/** Processo não visível nas rotas do risco = o próprio risco "não existe" (404 indistinguível). */
const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND';

/** O risco travado para escrita, com o processo já autorizado. */
export interface RiskWriteContext extends TypedCollectionWrite {
  readonly risk: Risk;
}

@Injectable()
export class RiskGate {
  constructor(
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /** RSK-01: visibilidade do processo (404) + o `RISK_MAP` e se o usuário pode gerenciar. */
  readable(tx: TenantTx, processId: string): Promise<TypedCollectionState> {
    return this.documents.typedCollectionStateIn(tx, { processId, ...RISK_COLLECTION });
  }

  /** RSK-02: POL-02 estendida (403/404/409/422) sobre o processo. */
  writable(tx: TenantTx, processId: string): Promise<TypedCollectionWrite> {
    return this.documents.assertTypedCollectionWritableIn(tx, { processId, ...RISK_COLLECTION });
  }

  /** RSK-03: o risco e a visibilidade do processo dele (senão 404 `NOT_FOUND`). */
  async readableRisk(
    tx: TenantTx,
    riskId: string,
  ): Promise<{ readonly risk: Risk; readonly state: TypedCollectionState }> {
    const risk = await this.risks.findById(tx, riskId);
    if (risk === null) throw riskNotFound();
    try {
      return { risk, state: await this.readable(tx, risk.processId) };
    } catch (error) {
      if (isNotFound(error)) throw riskNotFound();
      throw error;
    }
  }

  /** RSK-04/05: o risco (404) e a POL-02 estendida sobre o processo dele. */
  async writableRisk(tx: TenantTx, riskId: string): Promise<RiskWriteContext> {
    const found = await this.risks.findById(tx, riskId);
    if (found === null) throw riskNotFound();
    let write: TypedCollectionWrite;
    try {
      write = await this.writable(tx, found.processId);
    } catch (error) {
      if (isNotFound(error)) throw riskNotFound();
      throw error;
    }
    // Relido depois da trava do `RISK_MAP`: a versão conferida pelo `If-Match` é a vigente.
    const risk = await this.risks.findById(tx, riskId);
    if (risk === null) throw riskNotFound();
    return { ...write, risk };
  }
}

@Injectable()
export class RiskScaleReader {
  constructor(private readonly tenancy: TenancyFacade) {}

  /** Escala e faixas vigentes no tenant da transação (RN-RISK-04 — sem cache: FA-02). */
  async current(tx: TenantTx): Promise<RiskScaleSnapshot> {
    const values = await this.tenancy.settingValues(tx, ['risk.scale', 'risk.levelThresholds']);
    return {
      scale: riskScaleSettingSchema.parse(values.get('risk.scale')),
      levelThresholds: riskLevelThresholdsSettingSchema.parse(values.get('risk.levelThresholds')),
    };
  }
}

@Injectable()
export class RiskReferences {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /** V-04 (RN-RISK-05): item ativo do `RISK_CATEGORY` do tenant; devolve o código (evento). */
  async category(tx: TenantTx, categoryId: string): Promise<string> {
    return (await this.catalog.assertActive(tx, 'RISK_CATEGORY', categoryId, 'categoryId')).code;
  }

  /** V-05 (RN-RISK-06): vínculo ativo no tenant da transação (de outro tenant = inexistente). */
  async owner(tx: TenantTx, userId: string): Promise<void> {
    const [member] = await this.identity.membersInTenant(tx, [userId]);
    if (member === undefined) throw ownerReferenceError('ownerId', 'REFERENCE_NOT_FOUND');
    if (member.status !== 'ACTIVE') throw ownerReferenceError('ownerId', 'REFERENCE_INACTIVE');
  }

  /** V-05: unidade ativa do tenant da transação. */
  async ownerDepartment(tx: TenantTx, departmentId: string): Promise<void> {
    const department = (await this.organization.departmentReferences(tx, [departmentId])).get(
      departmentId,
    );
    if (department === undefined) {
      throw ownerReferenceError('ownerDepartmentId', 'REFERENCE_NOT_FOUND');
    }
    if (!department.isActive) {
      throw ownerReferenceError('ownerDepartmentId', 'REFERENCE_INACTIVE');
    }
  }
}

@Injectable()
export class RiskPresenter {
  constructor(
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /** Tratamentos vinculados por risco (DTO e diálogo de exclusão — RN-RISK-10). */
  async treatments(
    tx: TenantTx,
    riskIds: readonly string[],
  ): Promise<Map<string, RiskTreatmentRef[]>> {
    const byRisk = new Map<string, RiskTreatmentRef[]>();
    for (const treatment of await this.risks.treatmentsOf(tx, riskIds)) {
      byRisk.set(treatment.riskId, [...(byRisk.get(treatment.riskId) ?? []), treatment]);
    }
    return byRisk;
  }

  /** DTOs de RSK-01..04: rótulo da categoria (mesmo inativa — RN-TEN-61), responsáveis e tratamentos. */
  async present(tx: TenantTx, risks: readonly Risk[]): Promise<RiskDto[]> {
    const categories = new Map<string, { readonly code: string; readonly label: string }>();
    for (const id of new Set(risks.map((risk) => risk.categoryId))) {
      const item = await this.catalog.find(tx, id);
      categories.set(id, { code: item?.code ?? '', label: item?.label ?? '' });
    }
    const ownerIds = [...new Set(risks.flatMap((risk) => (risk.ownerId ? [risk.ownerId] : [])))];
    const departmentIds = [
      ...new Set(risks.flatMap((risk) => (risk.ownerDepartmentId ? [risk.ownerDepartmentId] : []))),
    ];
    const owners = ownerIds.length > 0 ? await this.identity.userDisplayNames(tx, ownerIds) : null;
    const departments =
      departmentIds.length > 0 ? await this.organization.departmentNames(tx, departmentIds) : null;
    const treatments = await this.treatments(
      tx,
      risks.map((risk) => risk.id),
    );
    return risks.map((risk) => ({
      id: risk.id,
      processId: risk.processId,
      code: risk.code,
      title: risk.title,
      description: risk.description,
      categoryId: risk.categoryId,
      category: {
        id: risk.categoryId,
        ...(categories.get(risk.categoryId) ?? { code: '', label: '' }),
      },
      phase: risk.phase,
      cause: risk.cause,
      consequence: risk.consequence,
      probability: risk.probability,
      impact: risk.impact,
      score: risk.score,
      level: risk.level,
      scaleSnapshot: {
        scale: risk.scaleSnapshot.scale,
        levelThresholds: [...risk.scaleSnapshot.levelThresholds],
      },
      ownerId: risk.ownerId,
      owner:
        risk.ownerId === null ? null : { id: risk.ownerId, name: owners?.get(risk.ownerId) ?? '' },
      ownerDepartmentId: risk.ownerDepartmentId,
      ownerDepartment:
        risk.ownerDepartmentId === null
          ? null
          : {
              id: risk.ownerDepartmentId,
              name: departments?.get(risk.ownerDepartmentId) ?? '',
            },
      residualProbability: risk.residualProbability,
      residualImpact: risk.residualImpact,
      residualScore: risk.residualScore,
      residualLevel: risk.residualLevel,
      status: risk.status,
      sortOrder: risk.sortOrder,
      treatments: (treatments.get(risk.id) ?? []).map(({ id, type, description, status }) => ({
        id,
        type,
        description,
        status,
      })),
      version: risk.version,
    }));
  }
}

/** Textos livres do risco: na auditoria, só hash + tamanho (story · "Logs"/"Auditoria"). */
const LONG_TEXT = new Set(['title', 'description', 'cause', 'consequence']);

function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

const audited = (field: string, value: unknown) =>
  LONG_TEXT.has(field) && typeof value === 'string' ? fingerprint(value) : value;

const toAuditChanges = (changes: readonly RiskChange[]): AuditChange[] =>
  changes.map((change) => ({
    path: change.field,
    old: audited(change.field, change.old),
    new: audited(change.field, change.new),
  }));

/** Campos da criação na auditoria (story · "Auditoria": categoria, fase, probabilidade, impacto). */
const CREATE_AUDIT_FIELDS = new Set(['categoryId', 'phase', 'probability', 'impact']);

@Injectable()
export class RiskChangeRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** `risk.create` + `RiskCreated` (timeline `RISK_ADDED` no mesmo `tx`). */
  async created(
    tx: TenantTx,
    risk: Risk,
    changes: readonly RiskChange[],
    categoryCode: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.create',
      entityType: 'Risk',
      entityId: risk.id,
      processId: risk.processId,
      changes: toAuditChanges(changes.filter((change) => CREATE_AUDIT_FIELDS.has(change.field))),
      metadata: { code: risk.code, level: risk.level, score: risk.score },
    });
    await this.outbox.record(
      tx,
      RiskCreated.of({
        aggregateId: risk.id,
        processId: risk.processId,
        payload: {
          riskId: risk.id,
          code: risk.code,
          level: risk.level,
          phase: risk.phase,
          categoryCode,
        },
      }),
    );
  }

  /**
   * RSK-04: com reavaliação, `risk.assess` (`fromScore`/`toScore`/`fromLevel`/`toLevel` e os demais
   * campos alterados) + `RiskAssessed` (mesmo sem mudança de nível — FA-01); senão `risk.update`.
   */
  async updated(
    tx: TenantTx,
    risk: Risk,
    changes: readonly RiskChange[],
    reassessment: RiskReassessment | null,
  ): Promise<void> {
    if (reassessment === null) {
      await this.audit.record(tx, {
        action: 'risk.update',
        entityType: 'Risk',
        entityId: risk.id,
        processId: risk.processId,
        changes: toAuditChanges(changes),
        metadata: { code: risk.code, version: risk.version },
      });
      return;
    }
    await this.audit.record(tx, {
      action: 'risk.assess',
      entityType: 'Risk',
      entityId: risk.id,
      processId: risk.processId,
      changes: [
        { path: 'score', old: reassessment.fromScore, new: reassessment.toScore },
        { path: 'level', old: reassessment.fromLevel, new: reassessment.toLevel },
        ...toAuditChanges(changes),
      ],
      metadata: {
        code: risk.code,
        fromScore: reassessment.fromScore,
        toScore: reassessment.toScore,
        fromLevel: reassessment.fromLevel,
        toLevel: reassessment.toLevel,
        version: risk.version,
      },
    });
    await this.outbox.record(
      tx,
      RiskAssessed.of({
        aggregateId: risk.id,
        processId: risk.processId,
        payload: {
          riskId: risk.id,
          fromLevel: reassessment.fromLevel,
          toLevel: reassessment.toLevel,
          score: reassessment.toScore,
        },
      }),
    );
  }

  /** `risk.delete` (código e tratamentos removidos) + `RiskDeleted` (timeline `RISK_REMOVED`). */
  async deleted(tx: TenantTx, risk: Risk, treatmentsRemoved: number): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.delete',
      entityType: 'Risk',
      entityId: risk.id,
      processId: risk.processId,
      metadata: { code: risk.code, treatmentsRemoved },
    });
    await this.outbox.record(
      tx,
      RiskDeleted.of({
        aggregateId: risk.id,
        processId: risk.processId,
        payload: { riskId: risk.id, code: risk.code },
      }),
    );
  }
}
