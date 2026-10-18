import { createHash } from 'node:crypto';

import {
  RISK_MESSAGES,
  RiskAssessed,
  RiskCreated,
  RiskDeleted,
  riskLevelThresholdsSettingSchema,
  riskScaleSettingSchema,
  RiskTreatmentChanged,
  TREATMENT_MESSAGES,
} from '@contrataflow/validation';
import type {
  RiskDto,
  RiskScaleSnapshot,
  RiskTreatmentChange,
  RiskTreatmentDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { RISK_REPOSITORY } from './ports.js';
import type { RiskRepository } from './ports.js';
import { ownerReferenceError, riskNotFound, treatmentNotFound } from './risk.errors.js';
import type { ResponsibleField } from './risk.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type {
  TypedCollectionState,
  TypedCollectionWrite,
} from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type {
  RiskTreatment,
  TreatmentChange,
  TreatmentStatusChange,
} from '../domain/risk-treatment.js';
import type { Risk, RiskChange, RiskReassessment } from '../domain/risk.js';

/*
 * Peças comuns dos casos de uso de riscos (US-033): a guarda (POL-02 estendida — RN-RISK-09 — pela
 * fachada do `document`, que trava o `RISK_MAP` no `tx`), a escala vigente do tenant
 * (`risk.scale`/`risk.levelThresholds`, lidas no `tx` — FA-02), as referências (categoria ativa do
 * `RISK_CATEGORY`, usuário e unidade responsáveis — V-04/V-05), o apresentador e a gravação dos
 * efeitos na mesma transação (auditoria `risk.*` e eventos `Risk*`, que projetam a timeline). Os
 * tratamentos (US-034) usam a mesma guarda (RN-RISK-16 = RN-RISK-09) com as mensagens deles.
 */

const COLLECTIONS = {
  risks: {
    systemModule: 'RISK_MAP',
    deniedDetail: RISK_MESSAGES.permissionDenied,
    lockedDetail: RISK_MESSAGES.locked,
  },
  treatments: {
    systemModule: 'RISK_MAP',
    deniedDetail: TREATMENT_MESSAGES.permissionDenied,
    lockedDetail: TREATMENT_MESSAGES.locked,
  },
} as const;

/** De quem são as mensagens de 403/409 da guarda: riscos (US-033) ou tratamentos (US-034). */
export type RiskCollection = keyof typeof COLLECTIONS;

/** Processo não visível nas rotas do risco = o próprio risco "não existe" (404 indistinguível). */
const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND';

/** O risco travado para escrita, com o processo já autorizado. */
export interface RiskWriteContext extends TypedCollectionWrite {
  readonly risk: Risk;
}

/** O tratamento (e o risco dele) travados para escrita, com o processo já autorizado. */
export interface TreatmentWriteContext extends RiskWriteContext {
  readonly treatment: RiskTreatment;
}

@Injectable()
export class RiskGate {
  constructor(
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /** RSK-01: visibilidade do processo (404) + o `RISK_MAP` e se o usuário pode gerenciar. */
  readable(tx: TenantTx, processId: string): Promise<TypedCollectionState> {
    return this.documents.typedCollectionStateIn(tx, { processId, ...COLLECTIONS.risks });
  }

  /** RSK-02: POL-02 estendida (403/404/409/422) sobre o processo. */
  writable(
    tx: TenantTx,
    processId: string,
    collection: RiskCollection = 'risks',
  ): Promise<TypedCollectionWrite> {
    return this.documents.assertTypedCollectionWritableIn(tx, {
      processId,
      ...COLLECTIONS[collection],
    });
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

  /** RSK-04/05/06: o risco (404) e a POL-02 estendida sobre o processo dele. */
  async writableRisk(
    tx: TenantTx,
    riskId: string,
    collection: RiskCollection = 'risks',
  ): Promise<RiskWriteContext> {
    const found = await this.risks.findById(tx, riskId);
    if (found === null) throw riskNotFound();
    let write: TypedCollectionWrite;
    try {
      write = await this.writable(tx, found.processId, collection);
    } catch (error) {
      if (isNotFound(error)) throw riskNotFound();
      throw error;
    }
    // Relido depois da trava do `RISK_MAP`: a versão conferida pelo `If-Match` é a vigente.
    const risk = await this.risks.findById(tx, riskId);
    if (risk === null) throw riskNotFound();
    return { ...write, risk };
  }

  /**
   * RSK-07/08 (RN-RISK-16): o tratamento (404), o risco dele e a POL-02 estendida sobre o processo;
   * o tratamento é relido depois da trava do `RISK_MAP` (a versão do `If-Match` é a vigente).
   */
  async writableTreatment(tx: TenantTx, treatmentId: string): Promise<TreatmentWriteContext> {
    const found = await this.risks.findTreatment(tx, treatmentId);
    if (found === null) throw treatmentNotFound();
    let context: RiskWriteContext;
    try {
      context = await this.writableRisk(tx, found.riskId, 'treatments');
    } catch (error) {
      if (isNotFound(error)) throw treatmentNotFound();
      throw error;
    }
    const treatment = await this.risks.findTreatment(tx, treatmentId);
    if (treatment === null) throw treatmentNotFound();
    return { ...context, treatment };
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

  /**
   * RSK-11 (US-119): categorias ATIVAS do `RISK_CATEGORY` por código (a proposta traz o código —
   * RN-AI-39); quem chama recusa o código ausente (`REFERENCE_INACTIVE`).
   */
  async activeCategoriesByCode(
    tx: TenantTx,
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly code: string }>> {
    const items = await this.catalog.activeItemsOf(tx, 'RISK_CATEGORY');
    return new Map(items.map((item) => [item.code, { id: item.id, code: item.code }]));
  }

  /**
   * V-05 (RN-RISK-06) · V-03 da US-034 (RN-RISK-13): vínculo ativo no tenant da transação (de
   * outro tenant = inexistente, sem revelar).
   */
  async owner(
    tx: TenantTx,
    userId: string,
    field: Extract<ResponsibleField, 'ownerId' | 'responsibleId'> = 'ownerId',
  ): Promise<void> {
    const [member] = await this.identity.membersInTenant(tx, [userId]);
    if (member === undefined) throw ownerReferenceError(field, 'REFERENCE_NOT_FOUND');
    if (member.status !== 'ACTIVE') throw ownerReferenceError(field, 'REFERENCE_INACTIVE');
  }

  /** V-05 · V-03 da US-034: unidade ativa do tenant da transação. */
  async ownerDepartment(
    tx: TenantTx,
    departmentId: string,
    field: Extract<
      ResponsibleField,
      'ownerDepartmentId' | 'responsibleDepartmentId'
    > = 'ownerDepartmentId',
  ): Promise<void> {
    const department = (await this.organization.departmentReferences(tx, [departmentId])).get(
      departmentId,
    );
    if (department === undefined) throw ownerReferenceError(field, 'REFERENCE_NOT_FOUND');
    if (!department.isActive) throw ownerReferenceError(field, 'REFERENCE_INACTIVE');
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

  /** Nomes de pessoas e unidades (riscos e tratamentos numa leitura só de cada fonte). */
  private async names(
    tx: TenantTx,
    userIds: readonly (string | null)[],
    departmentIds: readonly (string | null)[],
  ): Promise<Names> {
    const users = [...new Set(userIds.filter((id): id is string => id !== null))];
    const departments = [...new Set(departmentIds.filter((id): id is string => id !== null))];
    return {
      users: users.length > 0 ? await this.identity.userDisplayNames(tx, users) : null,
      departments:
        departments.length > 0 ? await this.organization.departmentNames(tx, departments) : null,
    };
  }

  /** DTO de RSK-06/07 (responsáveis com nome). */
  async presentTreatment(tx: TenantTx, treatment: RiskTreatment): Promise<RiskTreatmentDto> {
    const names = await this.names(
      tx,
      [treatment.responsibleId],
      [treatment.responsibleDepartmentId],
    );
    return treatmentDtoOf(treatment, names);
  }

  /** DTOs de RSK-01..04: rótulo da categoria (mesmo inativa — RN-TEN-61), responsáveis e tratamentos. */
  async present(tx: TenantTx, risks: readonly Risk[]): Promise<RiskDto[]> {
    const categories = new Map<string, { readonly code: string; readonly label: string }>();
    for (const id of new Set(risks.map((risk) => risk.categoryId))) {
      const item = await this.catalog.find(tx, id);
      categories.set(id, { code: item?.code ?? '', label: item?.label ?? '' });
    }
    const treatments = await this.risks.treatmentsOf(
      tx,
      risks.map((risk) => risk.id),
    );
    const names = await this.names(
      tx,
      [
        ...risks.map((risk) => risk.ownerId),
        ...risks.map((risk) => risk.aiReviewedById),
        ...treatments.map((row) => row.responsibleId),
      ],
      [
        ...risks.map((risk) => risk.ownerDepartmentId),
        ...treatments.map((row) => row.responsibleDepartmentId),
      ],
    );
    const owners = names.users;
    const departments = names.departments;
    const byRisk = new Map<string, RiskTreatmentDto[]>();
    for (const treatment of treatments) {
      byRisk.set(treatment.riskId, [
        ...(byRisk.get(treatment.riskId) ?? []),
        treatmentDtoOf(treatment, names),
      ]);
    }
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
      treatments: byRisk.get(risk.id) ?? [],
      aiGenerationId: risk.aiGenerationId,
      aiReviewedAt: risk.aiReviewedAt?.toISOString() ?? null,
      aiReviewedBy:
        risk.aiReviewedById === null
          ? null
          : { id: risk.aiReviewedById, name: owners?.get(risk.aiReviewedById) ?? '' },
      version: risk.version,
    }));
  }
}

interface Names {
  readonly users: ReadonlyMap<string, string> | null;
  readonly departments: ReadonlyMap<string, string> | null;
}

function treatmentDtoOf(treatment: RiskTreatment, names: Names): RiskTreatmentDto {
  return {
    id: treatment.id,
    riskId: treatment.riskId,
    processId: treatment.processId,
    type: treatment.type,
    description: treatment.description,
    responsibleId: treatment.responsibleId,
    responsible:
      treatment.responsibleId === null
        ? null
        : { id: treatment.responsibleId, name: names.users?.get(treatment.responsibleId) ?? '' },
    responsibleDepartmentId: treatment.responsibleDepartmentId,
    responsibleDepartment:
      treatment.responsibleDepartmentId === null
        ? null
        : {
            id: treatment.responsibleDepartmentId,
            name: names.departments?.get(treatment.responsibleDepartmentId) ?? '',
          },
    dueDate: treatment.dueDate,
    status: treatment.status,
    completedAt: treatment.completedAt?.toISOString() ?? null,
    notes: treatment.notes,
    sortOrder: treatment.sortOrder,
    version: treatment.version,
  };
}

/** Textos livres (risco e tratamento): na auditoria, só hash + tamanho (story · "Logs"/"Auditoria"). */
const LONG_TEXT = new Set(['title', 'description', 'cause', 'consequence', 'notes']);

function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

const audited = (field: string, value: unknown) =>
  LONG_TEXT.has(field) && typeof value === 'string' ? fingerprint(value) : value;

const toAuditChanges = (changes: readonly (RiskChange | TreatmentChange)[]): AuditChange[] =>
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
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.create',
      entityType: 'Risk',
      entityId: risk.id,
      processId: risk.processId,
      changes: toAuditChanges(changes.filter((change) => CREATE_AUDIT_FIELDS.has(change.field))),
      metadata: { code: risk.code, level: risk.level, score: risk.score, ...extra },
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

  /**
   * RSK-06 (US-034): `risk.treatment_create` (`riskId`, `type`; a transição automática do risco em
   * `changes` — RN-RISK-14) + `RiskTreatmentChanged` (`CREATED`, sem timeline).
   */
  async treatmentCreated(
    tx: TenantTx,
    treatment: RiskTreatment,
    riskStatus: { readonly from: string; readonly to: string } | null,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.treatment_create',
      entityType: 'RiskTreatment',
      entityId: treatment.id,
      processId: treatment.processId,
      changes:
        riskStatus === null
          ? []
          : [{ path: 'risk.status', old: riskStatus.from, new: riskStatus.to }],
      metadata: { riskId: treatment.riskId, type: treatment.type, ...extra },
    });
    await this.treatmentChanged(tx, treatment, 'CREATED');
  }

  /** RSK-07: `risk.treatment_update` (campos, `fromStatus`/`toStatus`) + `UPDATED`/`STATUS_CHANGED`. */
  async treatmentUpdated(
    tx: TenantTx,
    treatment: RiskTreatment,
    changes: readonly TreatmentChange[],
    statusChange: TreatmentStatusChange | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.treatment_update',
      entityType: 'RiskTreatment',
      entityId: treatment.id,
      processId: treatment.processId,
      changes: toAuditChanges(changes),
      metadata: {
        riskId: treatment.riskId,
        version: treatment.version,
        ...(statusChange === null
          ? {}
          : { fromStatus: statusChange.from, toStatus: statusChange.to }),
      },
    });
    await this.treatmentChanged(
      tx,
      treatment,
      statusChange === null ? 'UPDATED' : 'STATUS_CHANGED',
    );
  }

  /** RSK-08 (RN-RISK-17): `risk.treatment_delete` (`riskId`) + `RiskTreatmentChanged` (`DELETED`). */
  async treatmentDeleted(tx: TenantTx, treatment: RiskTreatment): Promise<void> {
    await this.audit.record(tx, {
      action: 'risk.treatment_delete',
      entityType: 'RiskTreatment',
      entityId: treatment.id,
      processId: treatment.processId,
      metadata: { riskId: treatment.riskId },
    });
    await this.treatmentChanged(tx, treatment, 'DELETED');
  }

  private async treatmentChanged(
    tx: TenantTx,
    treatment: RiskTreatment,
    change: RiskTreatmentChange,
  ): Promise<void> {
    await this.outbox.record(
      tx,
      RiskTreatmentChanged.of({
        aggregateId: treatment.riskId,
        processId: treatment.processId,
        payload: {
          riskId: treatment.riskId,
          treatmentId: treatment.id,
          change,
          status: treatment.status,
        },
      }),
    );
  }
}
