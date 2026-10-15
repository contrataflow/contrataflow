import {
  DepartmentCreated,
  DepartmentDeactivated,
  DepartmentMoved,
  DepartmentUpdated,
} from '@contrataflow/validation';
import type { CreateDepartment, DepartmentDto, UpdateDepartment } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  DEPARTMENT_CLOCK,
  DEPARTMENT_REPOSITORY,
  DEPARTMENT_TRANSACTIONS,
  DepartmentAcronymTakenError,
  DepartmentNameTakenError,
  DepartmentReferencedError,
} from './department-ports.js';
import type {
  DepartmentClock,
  DepartmentReferenceKind,
  DepartmentRepository,
  DepartmentTransactions,
} from './department-ports.js';
import { DepartmentReferences } from './department-references.js';
import type { StaffField } from './department-references.js';
import {
  acronymTaken,
  departmentCycle,
  departmentHasReferences,
  departmentNotFound,
  fieldNotAllowed,
  headEqualsDeputy,
  logSaveFailure,
  nameTaken,
  organizationRejected,
  parentRejected,
  versionConflict,
} from './department.errors.js';
import { toDepartmentDto } from './department.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { movingCreatesCycle } from '../domain/department-tree.js';
import {
  DepartmentFieldNotAllowedError,
  HeadEqualsDeputyError,
  createDepartment,
  moveDepartment,
  setDepartmentActive,
  updateDepartment,
} from '../domain/department.js';
import type { Department } from '../domain/department.js';

/** Campos de cadastro registrados na criação (auditoria `department.create`, nesta ordem). */
const CREATE_AUDIT_FIELDS = [
  'organizationId',
  'parentId',
  'type',
  'name',
  'acronym',
  'code',
  'email',
  'phone',
  'headUserId',
  'deputyUserId',
  'sortOrder',
] as const satisfies readonly (keyof Department)[];

/** Titular/substituto preenchidos da unidade, para a conferência de RN-TEN-48. */
function staffOf(
  department: Department,
  fields: readonly StaffField[] = ['headUserId', 'deputyUserId'],
): { field: StaffField; userId: string }[] {
  return fields.flatMap((field) => {
    const userId = department[field];
    return userId === null ? [] : [{ field, userId }];
  });
}

/** Unicidade de nome entre irmãos e de sigla no órgão (RN-TEN-47), excluindo a própria unidade. */
async function assertUnique(
  departments: DepartmentRepository,
  tx: TenantTx,
  department: Department,
  check: { readonly name: boolean; readonly acronym: boolean },
): Promise<void> {
  if (check.name) {
    const sibling = await departments.findSiblingByName(
      tx,
      department.organizationId,
      department.parentId,
      department.name,
    );
    if (sibling && sibling.id !== department.id) throw nameTaken();
  }
  if (check.acronym && department.acronym !== null) {
    const other = await departments.findByAcronym(
      tx,
      department.organizationId,
      department.acronym,
    );
    if (other && other.id !== department.id) throw acronymTaken();
  }
}

/** Corrida de duas gravações: o índice único decide (V-03/V-04). */
function uniqueViolationToApi(error: unknown): unknown {
  if (error instanceof DepartmentNameTakenError) return nameTaken();
  if (error instanceof DepartmentAcronymTakenError) return acronymTaken();
  return error;
}

interface Outcome {
  readonly department: Department;
  readonly written: boolean;
}

/**
 * Base dos casos de uso da unidade: autoriza (`DEPARTMENT_MANAGE`, sem variação de escopo —
 * permissions.md), roda a transação e registra `department.save_failed` nas falhas de gravação.
 */
abstract class DepartmentCommand {
  protected readonly logger = new Logger('Departments');

  constructor(
    protected readonly departments: DepartmentRepository,
    protected readonly transactions: DepartmentTransactions,
    protected readonly clock: DepartmentClock,
    protected readonly references: DepartmentReferences,
    protected readonly audit: AuditTrailPort,
    protected readonly outbox: OutboxWriterPort,
    protected readonly access: AccessFacade,
    protected readonly identity: IdentityFacade,
  ) {}

  protected async authorize(): Promise<void> {
    this.access.assertCan('DEPARTMENT_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
  }

  protected async transact<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    try {
      return await this.transactions.run(work);
    } catch (error) {
      logSaveFailure(this.logger, error, requireRequestContext().correlationId);
      throw error;
    }
  }

  /** Lê a unidade sob a RLS (outro tenant → 404) e confere o `If-Match` (412). */
  protected async load(tx: TenantTx, id: string, expectedVersion: number): Promise<Department> {
    const current = await this.departments.findById(tx, id);
    if (!current) throw departmentNotFound();
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    return current;
  }

  /** UPDATE versionado; corrida com outra transação vira 412 com a versão vencedora. */
  protected async persist(tx: TenantTx, next: Department, current: Department): Promise<void> {
    try {
      await this.departments.update(tx, next, current.version);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.departments.findById(tx, current.id);
        throw versionConflict(latest?.version ?? current.version + 1);
      }
      throw uniqueViolationToApi(error);
    }
  }

  protected logInfo(event: string, department: Department, extra: Record<string, unknown> = {}) {
    const context = requireRequestContext();
    this.logger.log(
      {
        event,
        departmentId: department.id,
        organizationId: department.organizationId,
        ...extra,
        tenantId: department.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      event,
    );
  }
}

export interface CreateDepartmentInput {
  readonly body: CreateDepartment;
}

/**
 * `CreateDepartmentCommand` — DEP-03 (US-102 · fluxo principal, passos 3–5): valida órgão ativo do
 * tenant, unidade superior do mesmo órgão (RN-TEN-44), unicidade (RN-TEN-47) e titular/substituto
 * elegíveis (RN-TEN-48); calcula `path`/`depth` (RN-TEN-45) e, numa transação, insere a unidade
 * ativa, grava `department.create` e `DepartmentCreated`. A árvore do órgão fica travada até o
 * commit: o caminho do pai não muda no meio da criação (movimentação concorrente).
 */
@Injectable()
export class CreateDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: CreateDepartmentInput): Promise<DepartmentDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const { body } = input;

    const created = await this.transact(async (tx) => {
      const organizationError = await this.references.organizationError(tx, body.organizationId);
      if (organizationError) throw validationError([organizationError]);
      await this.departments.lockTree(tx, body.organizationId);
      const parentCheck = await this.references.checkParent(
        tx,
        body.organizationId,
        body.parentId ?? null,
      );
      if (!parentCheck.ok) throw validationError([parentCheck.error]);

      let draft: Department;
      try {
        draft = createDepartment(body, {
          id: newId(),
          tenantId: context.tenantId ?? '',
          parent: parentCheck.parent,
          now,
          userId: context.actor.userId,
        });
      } catch (error) {
        if (error instanceof HeadEqualsDeputyError) throw headEqualsDeputy();
        throw error;
      }
      await assertUnique(this.departments, tx, draft, { name: true, acronym: true });
      const staffErrors = await this.references.staffErrors(tx, draft.id, staffOf(draft), now);
      if (staffErrors.length > 0) throw validationError(staffErrors);

      try {
        await this.departments.insert(tx, draft);
      } catch (error) {
        throw uniqueViolationToApi(error);
      }
      const changes: AuditChange[] = CREATE_AUDIT_FIELDS.filter(
        (field) => draft[field] !== null,
      ).map((field) => ({ path: field, old: null, new: draft[field] }));
      await this.audit.record(tx, {
        action: 'department.create',
        entityType: 'Department',
        entityId: draft.id,
        changes,
        metadata: { organizationId: draft.organizationId, parentId: draft.parentId },
      });
      await this.outbox.record(
        tx,
        DepartmentCreated.of({ aggregateId: draft.id, payload: { departmentId: draft.id } }),
      );
      return draft;
    });

    this.logInfo('department.created', created, { parentId: created.parentId });
    return toDepartmentDto(created);
  }
}

export interface UpdateDepartmentInput {
  readonly id: string;
  readonly patch: UpdateDepartment;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `UpdateDepartmentCommand` — DEP-05 (US-102 · fluxo principal, passo 6): tipo, nome, sigla,
 * código, contato, titular/substituto e ordem. Reaplica unicidade (RN-TEN-47) e a elegibilidade de
 * quem passou a ser titular/substituto (RN-TEN-48 — a aprovação já resolvida não muda: snapshot em
 * `Approval.approverUserId`); grava `department.update` (anterior/novo) e `DepartmentUpdated`
 * (`changedFields`). Nada alterado → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class UpdateDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: UpdateDepartmentInput): Promise<DepartmentDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();

    let changedFields: readonly string[] = [];
    const outcome = await this.transact(async (tx): Promise<Outcome> => {
      const current = await this.load(tx, input.id, input.expectedVersion);
      let result;
      try {
        result = updateDepartment(current, input.patch, { now, userId: context.actor.userId });
      } catch (error) {
        if (error instanceof HeadEqualsDeputyError) throw headEqualsDeputy();
        if (error instanceof DepartmentFieldNotAllowedError) throw fieldNotAllowed(error.field);
        throw error;
      }
      if (result.changedFields.length === 0) return { department: current, written: false };

      const { next } = result;
      await assertUnique(this.departments, tx, next, {
        name: result.changedFields.includes('name'),
        acronym: result.changedFields.includes('acronym'),
      });
      const staffErrors = await this.references.staffErrors(
        tx,
        current.id,
        staffOf(next, result.staffToValidate),
        now,
      );
      if (staffErrors.length > 0) throw validationError(staffErrors);

      await this.persist(tx, next, current);
      await this.audit.record(tx, {
        action: 'department.update',
        entityType: 'Department',
        entityId: current.id,
        changes: result.changes,
        metadata: { organizationId: current.organizationId },
      });
      await this.outbox.record(
        tx,
        DepartmentUpdated.of({
          aggregateId: current.id,
          payload: { departmentId: current.id, changedFields: [...result.changedFields] },
        }),
      );
      changedFields = result.changedFields;
      return { department: { ...next, version: current.version + 1 }, written: true };
    });

    if (outcome.written) this.logInfo('department.updated', outcome.department, { changedFields });
    return toDepartmentDto(outcome.department);
  }
}

export interface MoveDepartmentInput {
  readonly id: string;
  /** Nova unidade superior; `null` = raiz do órgão. */
  readonly parentId: string | null;
  readonly expectedVersion: number;
}

/**
 * `MoveDepartmentCommand` — DEP-06 (US-102 · fluxo principal, passo 7 · RN-TEN-45/46): trava a
 * árvore do órgão e a subárvore (`SELECT … FOR UPDATE`), relê tudo depois da trava, recusa destino
 * de outro órgão (`REFERENCE_NOT_FOUND`), a própria unidade ou um descendente (`DEPARTMENT_CYCLE`)
 * e recalcula `path`/`depth` da subárvore inteira na mesma transação, com `department.move` e
 * `DepartmentMoved`. Dois `move` cruzados simultâneos: o segundo espera a trava, relê o caminho já
 * movido e falha por ciclo — a árvore nunca fica com ciclo.
 */
@Injectable()
export class MoveDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: MoveDepartmentInput): Promise<DepartmentDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();

    let fromParentId: string | null = null;
    let descendants = 0;
    const outcome = await this.transact(async (tx): Promise<Outcome> => {
      const located = await this.departments.findById(tx, input.id);
      if (!located) throw departmentNotFound();
      await this.departments.lockTree(tx, located.organizationId);
      // Depois da trava: o caminho lido é o que nenhuma outra movimentação está reescrevendo.
      const current = await this.load(tx, input.id, input.expectedVersion);
      if (input.parentId === current.parentId) return { department: current, written: false };

      const target =
        input.parentId === null ? null : await this.departments.findById(tx, input.parentId);
      if (input.parentId !== null && target?.organizationId !== current.organizationId) {
        throw validationError([parentRejected('NOT_FOUND')]);
      }
      if (movingCreatesCycle(current, target)) {
        this.logger.warn(
          {
            event: 'department.move_blocked_cycle',
            departmentId: current.id,
            targetParentId: input.parentId,
            tenantId: current.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          'department.move_blocked_cycle',
        );
        throw departmentCycle();
      }
      if (target && !target.isActive) throw validationError([parentRejected('INACTIVE')]);

      const next = moveDepartment(current, target, { now, userId: context.actor.userId });
      await assertUnique(this.departments, tx, next, { name: true, acronym: false });
      descendants = await this.departments.lockSubtree(tx, current);
      try {
        descendants = await this.departments.moveSubtree(tx, next, current, current.version);
      } catch (error) {
        if (error instanceof VersionConflictError) {
          const latest = await this.departments.findById(tx, current.id);
          throw versionConflict(latest?.version ?? current.version + 1);
        }
        throw uniqueViolationToApi(error);
      }
      fromParentId = current.parentId;
      await this.audit.record(tx, {
        action: 'department.move',
        entityType: 'Department',
        entityId: current.id,
        changes: [{ path: 'parentId', old: current.parentId, new: next.parentId }],
        metadata: {
          organizationId: current.organizationId,
          fromParentId: current.parentId,
          toParentId: next.parentId,
          descendantsRecalculated: descendants,
        },
      });
      await this.outbox.record(
        tx,
        DepartmentMoved.of({
          aggregateId: current.id,
          payload: {
            departmentId: current.id,
            fromParentId: current.parentId,
            toParentId: next.parentId,
          },
        }),
      );
      return { department: { ...next, version: current.version + 1 }, written: true };
    });

    if (outcome.written) {
      this.logInfo('department.moved', outcome.department, {
        fromParentId,
        toParentId: outcome.department.parentId,
        descendantsRecalculated: descendants,
      });
    }
    return toDepartmentDto(outcome.department);
  }
}

export interface ToggleDepartmentInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/**
 * `ActivateDepartmentCommand` — DEP-08 (RN-TEN-50 · V-09): exige o órgão ativo
 * (`REFERENCE_INACTIVE` em `organizationId`). Grava `department.update` (`isActive` falso →
 * verdadeiro) e `DepartmentUpdated`; já ativa → 200 sem efeitos.
 */
@Injectable()
export class ActivateDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: ToggleDepartmentInput): Promise<DepartmentDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const outcome = await this.transact(async (tx): Promise<Outcome> => {
      const current = await this.load(tx, input.id, input.expectedVersion);
      const next = setDepartmentActive(current, true, { now, userId: context.actor.userId });
      if (next === null) return { department: current, written: false };
      const status = await this.references.organizationError(tx, current.organizationId);
      if (status) throw validationError([organizationRejected('INACTIVE')]);
      await this.persist(tx, next, current);
      await this.audit.record(tx, {
        action: 'department.update',
        entityType: 'Department',
        entityId: current.id,
        changes: [{ path: 'isActive', old: false, new: true }],
        metadata: { organizationId: current.organizationId, reactivated: true },
      });
      await this.outbox.record(
        tx,
        DepartmentUpdated.of({
          aggregateId: current.id,
          payload: { departmentId: current.id, changedFields: ['isActive'] },
        }),
      );
      return { department: { ...next, version: current.version + 1 }, written: true };
    });
    if (outcome.written) {
      this.logInfo('department.updated', outcome.department, { changedFields: ['isActive'] });
    }
    return toDepartmentDto(outcome.department);
  }
}

/**
 * `DeactivateDepartmentCommand` — DEP-07 (RN-TEN-50 · FA-04): permitido mesmo com processos em
 * andamento (acesso histórico mantido — DEC-024); a unidade só some das opções de novos vínculos e
 * processos. Grava `department.deactivate` e `DepartmentDeactivated`; já inativa → 200 sem efeitos.
 */
@Injectable()
export class DeactivateDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: ToggleDepartmentInput): Promise<DepartmentDto> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    const outcome = await this.transact(async (tx): Promise<Outcome> => {
      const current = await this.load(tx, input.id, input.expectedVersion);
      const next = setDepartmentActive(current, false, { now, userId: context.actor.userId });
      if (next === null) return { department: current, written: false };
      await this.persist(tx, next, current);
      await this.audit.record(tx, {
        action: 'department.deactivate',
        entityType: 'Department',
        entityId: current.id,
        metadata: { organizationId: current.organizationId },
      });
      await this.outbox.record(
        tx,
        DepartmentDeactivated.of({
          aggregateId: current.id,
          payload: { departmentId: current.id },
        }),
      );
      return { department: { ...next, version: current.version + 1 }, written: true };
    });
    if (outcome.written) this.logInfo('department.deactivated', outcome.department);
    return toDepartmentDto(outcome.department);
  }
}

/**
 * `DeleteDepartmentCommand` — DEP-09 (US-102 · fluxo principal, passo 9 · RN-TEN-51): exclusão
 * física da unidade criada por engano, só sem referências — sub-unidades e lotações conferidas
 * antes; as demais (etapa de workflow com unidade fixa e, com a US-001, processos e
 * `ProcessAccess`) pelas FKs `ON DELETE RESTRICT`. Referenciada → 409 `DEPARTMENT_HAS_REFERENCES`
 * (FA-05: a UI oferece "Desativar"). Grava `department.delete` com os dados da unidade removida.
 */
@Injectable()
export class DeleteDepartmentCommand extends DepartmentCommand {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) departments: DepartmentRepository,
    @Inject(DEPARTMENT_TRANSACTIONS) transactions: DepartmentTransactions,
    @Inject(DEPARTMENT_CLOCK) clock: DepartmentClock,
    references: DepartmentReferences,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    access: AccessFacade,
    identity: IdentityFacade,
  ) {
    super(departments, transactions, clock, references, audit, outbox, access, identity);
  }

  async execute(input: ToggleDepartmentInput): Promise<void> {
    await this.authorize();
    const removed = await this.transact(async (tx) => {
      const current = await this.load(tx, input.id, input.expectedVersion);
      const references: DepartmentReferenceKind[] = [];
      if ((await this.departments.countChildren(tx, current.id)) > 0) references.push('SUBUNITS');
      if (await this.identity.hasDepartmentAssignments(tx, current.id)) {
        references.push('ASSIGNMENTS');
      }
      if (references.length > 0) throw departmentHasReferences(references);
      try {
        await this.departments.delete(tx, current, current.version);
      } catch (error) {
        if (error instanceof DepartmentReferencedError) {
          throw departmentHasReferences([error.reference]);
        }
        if (error instanceof VersionConflictError) {
          const latest = await this.departments.findById(tx, current.id);
          throw versionConflict(latest?.version ?? current.version + 1);
        }
        throw error;
      }
      await this.audit.record(tx, {
        action: 'department.delete',
        entityType: 'Department',
        entityId: current.id,
        metadata: {
          organizationId: current.organizationId,
          parentId: current.parentId,
          type: current.type,
          name: current.name,
          acronym: current.acronym,
          code: current.code,
          path: current.path,
          isActive: current.isActive,
        },
      });
      return current;
    });
    this.logInfo('department.deleted', removed);
  }
}
