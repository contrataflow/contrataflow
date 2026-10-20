import { createHash } from 'node:crypto';

import { localDateOf } from '@contrataflow/types';
import {
  DFD_MESSAGES,
  DFD_TEXT_FIELDS,
  DFD_WIZARD_FIELDS,
  DOCUMENT_SECTION_MESSAGES,
  dfdPatchIssues,
} from '@contrataflow/validation';
import type {
  DfdConflictCurrent,
  DfdDto,
  DfdMeta,
  DfdPatch,
  FieldError,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { DRAFT_AUDIT_COALESCER } from '#shared/audit/draft-audit.js';
import type { DraftAuditCoalescerPort, DraftAuditTicket } from '#shared/audit/draft-audit.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { toDfdDto, toDfdMeta } from './dfd.presenter.js';
import { dfdNotFound } from './dfd.queries.js';
import { DFD_CLOCK, DFD_REPOSITORY, DFD_TRANSACTIONS } from './ports.js';
import type { DfdClock, DfdRepository, DfdTransactions } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { EditableTypedDocument } from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { applyDfdPatch, isInSecretariat } from '../domain/dfd.js';
import type { Dfd, DfdHeaderChange } from '../domain/dfd.js';

/*
 * DFD-04 — gravação parcial do cabeçalho (US-015 · RN-DFD-27/30/35): o `PATCH` do autosave com
 * APENAS os campos alterados e `If-Match: "<version>"`. Antes da transação, a janela da auditoria
 * coalescida dos textos (Redis). Numa transação: DFD do tenant (404 `DFD_NOT_FOUND`) → documento
 * travado, visível, POL-02 de edição (403 `NOT_PROCESS_CUSTODIAN`, 409, 422) e editável (409) →
 * `If-Match` (412 com `meta.current` para o merge do cliente — RN-DFD-28) → POL-09 da estimativa
 * (403) → regras de campo e de referência (422) → `version + 1` condicionada → auditoria
 * (`document.draft_update`: imediata com `changes` nos campos de dados, coalescida nos textos —
 * hash + tamanho; o passo do wizard não é auditado). Sem evento de domínio. Logs sem valores.
 */

/** Valor mascarado da estimativa sigilosa na auditoria (POL-09 · RN-DFD-16). */
const MASKED = '[MASKED]';

const TEXT_FIELDS: ReadonlySet<string> = new Set(DFD_TEXT_FIELDS);
const WIZARD_FIELDS: ReadonlySet<string> = new Set(DFD_WIZARD_FIELDS);

function fingerprint(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

export interface PatchDfdHeaderInput {
  readonly dfdId: string;
  readonly expectedVersion: number;
  readonly patch: DfdPatch;
}

export interface PatchedDfd {
  readonly dto: DfdDto;
  readonly meta: DfdMeta;
  readonly changedFields: readonly string[];
  /** Os textos foram auditados agora (a janela da coalescência foi usada). */
  readonly textAudited: boolean;
}

interface CommandInput extends PatchDfdHeaderInput {
  readonly ticket: DraftAuditTicket | null;
}

@Injectable()
export class PatchDfdHeaderCommand extends TransactionalCommandHandler<
  CommandInput,
  undefined,
  PatchedDfd
> {
  constructor(
    @Inject(DFD_TRANSACTIONS) transactions: DfdTransactions,
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    @Inject(DFD_CLOCK) private readonly clock: DfdClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(DRAFT_AUDIT_COALESCER) private readonly coalescer: DraftAuditCoalescerPort,
    private readonly documents: DocumentFacade,
    private readonly numbering: NumberingFacade,
    private readonly organization: OrganizationFacade,
    private readonly identity: IdentityFacade,
  ) {
    super('dfd.header_save', transactions);
  }

  /** Janela da coalescência só quando o patch traz texto livre (os demais campos são imediatos). */
  async save(input: PatchDfdHeaderInput): Promise<PatchedDfd> {
    const context = requireRequestContext();
    const hasText = Object.keys(input.patch).some((field) => TEXT_FIELDS.has(field));
    const ticket = hasText
      ? await this.coalescer.open({
          tenantId: context.tenantId ?? '',
          documentId: input.dfdId,
          target: 'HEADER',
          userId: context.actor.userId ?? '',
        })
      : null;
    let result: PatchedDfd;
    try {
      result = await this.execute({ ...input, ticket });
    } catch (error) {
      if (ticket !== null) await this.coalescer.abandon(ticket);
      throw error;
    }
    if (ticket !== null) {
      if (result.textAudited && ticket.record) {
        await this.coalescer.recorded(ticket, result.dto.version);
      } else if (!result.textAudited) {
        await this.coalescer.abandon(ticket);
      }
    }
    return result;
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: CommandInput): Promise<PatchedDfd> {
    const dfd = await this.dfds.findById(tx, input.dfdId);
    if (dfd === null) throw dfdNotFound();
    const view = await this.documents.editableTypedDocumentIn(tx, dfd.documentId, {
      notCustodianDetail: DOCUMENT_SECTION_MESSAGES.notCustodian,
    });
    if (view === null) throw dfdNotFound();
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    if (dfd.version !== input.expectedVersion) throw await this.conflict(tx, dfd, view, masked);
    if (input.patch.estimatedValue !== undefined && masked) {
      throw new ApiError('PERMISSION_DENIED', {
        detail: DFD_MESSAGES.permissionDenied,
        auditReasonCode: 'POL-09',
        auditDenial: true,
      });
    }
    const now = this.clock();
    await this.assertValid(tx, dfd, view, input.patch, now);

    const actorId = requireRequestContext().actor.userId ?? '';
    const { dfd: next, changes } = applyDfdPatch(dfd, input.patch, { actorId, now });
    if (changes.length === 0) {
      return {
        dto: toDfdDto(dfd, view.document, { masked }),
        meta: toDfdMeta(view.template, view.allowedActions),
        changedFields: [],
        textAudited: false,
      };
    }
    const saved = await this.persist(tx, next, input.expectedVersion, view, masked);
    const textAudited = await this.record(tx, saved, changes, view, input.ticket);
    return {
      dto: toDfdDto(saved, view.document, { masked }),
      meta: toDfdMeta(view.template, view.allowedActions),
      changedFields: changes.map((change) => change.field),
      textAudited,
    };
  }

  protected override committed(result: PatchedDfd, durationMs: number): void {
    if (result.changedFields.length === 0) return;
    this.logger.log(
      {
        event: 'dfd.header_saved',
        dfdId: result.dto.id,
        changedFields: result.changedFields,
        version: result.dto.version,
        durationMs,
      },
      'dfd.header_saved',
    );
  }

  /** RN-DFD-09..16 nos campos enviados (V-12) + setor da secretaria e responsável ativo. */
  private async assertValid(
    tx: TenantTx,
    dfd: Dfd,
    view: EditableTypedDocument,
    patch: DfdPatch,
    now: Date,
  ): Promise<void> {
    const { timezone } = await this.numbering.settingsOf(tx);
    const merged = {
      requestDate: patch.requestDate ?? dfd.requestDate,
      expectedDate: patch.expectedDate === undefined ? dfd.expectedDate : patch.expectedDate,
      pcaStatus: patch.pcaStatus ?? dfd.pcaStatus,
      pcaYear: patch.pcaYear === undefined ? dfd.pcaYear : patch.pcaYear,
      pcaJustification:
        patch.pcaJustification === undefined ? dfd.pcaJustification : patch.pcaJustification,
    };
    const errors: FieldError[] = dfdPatchIssues(patch, merged, {
      today: localDateOf(now, timezone),
    }).map((issue) => ({ field: issue.field, code: issue.code, message: issue.message }));

    const departmentId = patch.requestingDepartmentId;
    if (departmentId !== undefined && departmentId !== dfd.requestingDepartmentId) {
      const department = (await this.organization.departmentReferences(tx, [departmentId])).get(
        departmentId,
      );
      if (department === undefined) {
        errors.push({
          field: 'requestingDepartmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: DFD_MESSAGES.departmentRequired,
        });
      } else if (!department.isActive) {
        errors.push({
          field: 'requestingDepartmentId',
          code: 'REFERENCE_INACTIVE',
          message: DFD_MESSAGES.departmentInactive,
        });
      } else if (
        !isInSecretariat(department, {
          id: view.process.requestingSecretariatId,
          organizationId: view.process.organizationId,
        })
      ) {
        errors.push({
          field: 'requestingDepartmentId',
          code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
          message: DFD_MESSAGES.departmentNotInSecretariat,
        });
      }
    }
    const responsibleId = patch.responsibleId;
    if (responsibleId !== undefined && responsibleId !== dfd.responsibleId) {
      const membership = await this.identity.membershipOfUser(tx, responsibleId);
      const active =
        membership !== null &&
        membership.status === 'ACTIVE' &&
        (membership.expiresAt === null || membership.expiresAt.getTime() > now.getTime());
      if (!active) {
        errors.push({
          field: 'responsibleId',
          code: membership === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
          message: DFD_MESSAGES.responsibleInactive,
        });
      }
    }
    if (errors.length > 0) throw validationError(errors);
  }

  /** Grava condicionado à versão; corrida perdida → 412 com o DFD vencedor. */
  private async persist(
    tx: TenantTx,
    next: Dfd,
    expectedVersion: number,
    view: EditableTypedDocument,
    masked: boolean,
  ): Promise<Dfd> {
    try {
      await this.dfds.update(tx, next, expectedVersion);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const latest = await this.dfds.findById(tx, next.id);
      if (latest === null) throw dfdNotFound();
      throw await this.conflict(tx, latest, view, masked);
    }
    return { ...next, version: expectedVersion + 1 };
  }

  /**
   * `document.draft_update` (RN-DFD-35): campos de dados → registro imediato com `changes` (os
   * textos do mesmo patch vão junto, como hash + tamanho); só textos → registro coalescido pela
   * janela (faixa de versões do cabeçalho); só o passo do wizard → nada. Devolve se a janela foi
   * usada.
   */
  private async record(
    tx: TenantTx,
    saved: Dfd,
    changes: readonly DfdHeaderChange[],
    view: EditableTypedDocument,
    ticket: DraftAuditTicket | null,
  ): Promise<boolean> {
    const audited = changes.filter((change) => !WIZARD_FIELDS.has(change.field));
    if (audited.length === 0) return false;
    const structured = audited.some((change) => !TEXT_FIELDS.has(change.field));
    if (!structured && ticket?.record !== true) return false;
    const auditChanges: AuditChange[] = audited.map((change) => {
      if (TEXT_FIELDS.has(change.field)) {
        return { path: change.field, old: fingerprint(change.old), new: fingerprint(change.new) };
      }
      if (change.field === 'estimatedValue' && view.isBudgetConfidential) {
        return { path: change.field, old: MASKED, new: MASKED };
      }
      return { path: change.field, old: change.old, new: change.new };
    });
    await this.audit.record(tx, {
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: saved.documentId,
      processId: saved.processId,
      changes: auditChanges,
      metadata: {
        documentCode: view.document.code,
        target: 'HEADER',
        fields: audited.map((change) => change.field),
        ...(structured || ticket === null
          ? { version: saved.version }
          : {
              fromRevision: this.coalescer.fromRevision(ticket, saved.version),
              toRevision: saved.version,
              windowMinutes: 10,
            }),
      },
    });
    return !structured;
  }

  /** 412 `VERSION_CONFLICT` com o DFD atual e quem o gravou (FA-02 · RN-DFD-28). */
  private async conflict(
    tx: TenantTx,
    current: Dfd,
    view: EditableTypedDocument,
    masked: boolean,
  ): Promise<ApiError> {
    const updatedById = current.updatedById;
    const names =
      updatedById === null
        ? new Map<string, string>()
        : await this.identity.userDisplayNames(tx, [updatedById]);
    const body: DfdConflictCurrent = {
      ...toDfdDto(current, view.document, { masked }),
      updatedBy:
        updatedById === null ? null : { id: updatedById, name: names.get(updatedById) ?? null },
    };
    return new ApiError('VERSION_CONFLICT', {
      detail: 'Outra pessoa alterou este DFD. Suas alterações serão conferidas com as dela.',
      extensions: { currentVersion: current.version, meta: { current: body } },
    });
  }
}
