import {
  ETP_ESTIMATE_MESSAGES,
  etpEstimateIssues,
  etpPatchTouchesEstimate,
  normalizeEtpMoney,
} from '@contrataflow/validation';
import type {
  EtpDetailDto,
  EtpDetailMeta,
  EtpEstimatedValueSource,
  EtpUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { PriceResearchSummaryRegistry } from '#shared/price-research/price-research-summary.js';

import { toEtpDetailDto, toEtpDetailMeta } from './etp.presenter.js';
import { etpNotFound } from './etp.queries.js';
import { ETP_CLOCK, ETP_REPOSITORY, ETP_TRANSACTIONS } from './ports.js';
import type { EtpClock, EtpRepository, EtpTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { EditableTypedDocument } from '../../document/application/document.facade.js';
import { setEtpConclusion, setEtpEstimate } from '../domain/etp.js';
import type { Etp, EtpConclusionChange, EtpEstimate, EtpEstimateChange } from '../domain/etp.js';

/*
 * ETP-04 — Atualizar ETP: painel "Valor estimado" (US-022 · RN-ETP-28/30/32) e conclusão/
 * parcelamento (US-023 · RN-ETP-34/35), com `If-Match: "<version do ETP>"`. Numa transação: ETP
 * do tenant (404) → documento travado, visível, `ETP_UPDATE` + POL-02 — custódia OU participação
 * `COLLABORATOR`/`CONSULTANT` (403), processo editável (409), tipo na etapa (422) — e em
 * `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE` — V-07) → `If-Match` (412 `VERSION_CONFLICT` —
 * V-08) → só quando o corpo mexe nas estimativas: POL-09 (quem não vê o valor também não o altera —
 * 403), RN-ETP-28 (422 — V-04/V-05) e a pesquisa não cancelada do MESMO processo (V-06:
 * `REFERENCE_NOT_FOUND`, inclusive de outro tenant, sem revelar; cancelada = `REFERENCE_INACTIVE`)
 * → conclusão/parcelamento (sem POL-09: não revelam valor) → UMA `version + 1` condicionada →
 * `document.draft_update` (lacuna 1 das US-022/023; valor mascarado em processo sigiloso, conclusão
 * e parcelamento com os valores anterior e novo). O valor vinculado é a cópia do total da
 * pesquisa — dali em diante o worker o sincroniza (RN-ETP-29). Sem evento de domínio nem
 * notificação. Logs sem valores.
 */

/** Valor mascarado da estimativa sigilosa na auditoria (POL-09). */
const MASKED = '[MASKED]';

let savedCounter: Counter | undefined;

/** `etp_estimate_saved_total{source}` — gravações efetivas do valor estimado, por origem. */
function countEstimateSaved(source: EtpEstimatedValueSource): void {
  savedCounter ??= metrics.getMeter('contrataflow-api').createCounter('etp_estimate_saved_total', {
    description: 'Valor estimado do ETP definido (manual ou vinculado à pesquisa), por origem.',
  });
  savedCounter.add(1, { source });
}

type EtpHeaderChange = EtpEstimateChange | EtpConclusionChange;

const ESTIMATE_FIELDS: ReadonlySet<string> = new Set([
  'estimatedValueSource',
  'estimatedTotalValue',
  'priceResearchId',
]);

export interface UpdateEtpInput {
  readonly etpId: string;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
  readonly patch: EtpUpdate;
}

export interface UpdatedEtp {
  readonly dto: EtpDetailDto;
  readonly meta: EtpDetailMeta;
  /** Campos alterados (vazio = nada mudou: sem gravação nem auditoria). */
  readonly changedFields: readonly string[];
}

@Injectable()
export class UpdateEtpCommand extends TransactionalCommandHandler<
  UpdateEtpInput,
  undefined,
  UpdatedEtp
> {
  constructor(
    @Inject(ETP_TRANSACTIONS) transactions: EtpTransactions,
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    @Inject(ETP_CLOCK) private readonly clock: EtpClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly documents: DocumentFacade,
    private readonly researches: PriceResearchSummaryRegistry,
  ) {
    super('etp.estimate_save', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: UpdateEtpInput): Promise<UpdatedEtp> {
    const found = await this.etps.findById(tx, input.etpId);
    if (found === null) throw etpNotFound();
    const view = await this.editable(tx, found);
    // Relido depois da trava do documento: a versão conferida pelo `If-Match` é a vigente.
    const etp = await this.etps.findById(tx, found.id);
    if (etp === null) throw etpNotFound();
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    if (etp.version !== input.expectedVersion) throw versionConflict(etp.version);
    const stamp = { actorId: requireRequestContext().actor.userId, now: this.clock() };

    let next = etp;
    const changes: EtpHeaderChange[] = [];
    if (etpPatchTouchesEstimate(input.patch)) {
      if (masked) {
        throw new ApiError('PERMISSION_DENIED', {
          detail: ETP_ESTIMATE_MESSAGES.permissionDenied,
          auditReasonCode: 'POL-09',
          auditDenial: true,
        });
      }
      const issues = etpEstimateIssues(input.patch);
      if (issues.length > 0) throw validationError(issues);
      const estimated = setEtpEstimate(next, await this.resolve(tx, etp, input.patch), stamp);
      next = estimated.etp;
      changes.push(...estimated.changes);
    }
    const concluded = setEtpConclusion(next, input.patch, stamp);
    changes.push(...concluded.changes);
    // Uma versão por gravação, ainda que estimativa e conclusão mudem juntas.
    next = changes.length === 0 ? etp : { ...concluded.etp, version: etp.version + 1 };

    if (changes.length > 0) {
      await this.persist(tx, next, input.expectedVersion);
      await this.record(tx, next, changes, view);
    }
    const items = await this.documents.documentItemsIn(tx, next.documentId);
    return {
      dto: toEtpDetailDto(next, view.document, items.length, { masked }),
      meta: toEtpDetailMeta(view.template, view.allowedActions),
      changedFields: changes.map((change) => change.field),
    };
  }

  protected override committed(result: UpdatedEtp, durationMs: number): void {
    if (result.changedFields.length === 0) return;
    const correlationId = requireRequestContext().correlationId;
    if (result.changedFields.some((field) => ESTIMATE_FIELDS.has(field))) {
      const source = result.dto.estimatedValueSource;
      if (source !== null) countEstimateSaved(source);
      this.logger.log(
        {
          event: 'etp.estimate_saved',
          etpId: result.dto.id,
          estimatedValueSource: source,
          priceResearchId: result.dto.priceResearchId,
          changedFields: result.changedFields,
          version: result.dto.version,
          durationMs,
          correlationId,
        },
        'etp.estimate_saved',
      );
    }
    if (result.changedFields.some((field) => !ESTIMATE_FIELDS.has(field))) {
      this.logger.log(
        {
          event: 'etp.conclusion_saved',
          etpId: result.dto.id,
          conclusion: result.dto.conclusion,
          parcelingDecision: result.dto.parcelingDecision,
          version: result.dto.version,
          durationMs,
          correlationId,
        },
        'etp.conclusion_saved',
      );
    }
  }

  /** POL-02 de edição pelo `document`, com as mensagens da US-022; `null` = o 404 do ETP. */
  private async editable(tx: TenantTx, etp: Etp): Promise<EditableTypedDocument> {
    let view: EditableTypedDocument | null;
    try {
      view = await this.documents.editableTypedDocumentIn(tx, etp.documentId, {
        notCustodianDetail: ETP_ESTIMATE_MESSAGES.permissionDenied,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DOCUMENT_NOT_EDITABLE') {
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: ETP_ESTIMATE_MESSAGES.notEditable,
          extensions: error.extensions,
        });
      }
      throw error;
    }
    if (view === null) throw etpNotFound();
    return view;
  }

  /** RN-ETP-28: o valor manual normalizado ou a cópia do total da pesquisa do processo (V-06). */
  private async resolve(tx: TenantTx, etp: Etp, patch: EtpUpdate): Promise<EtpEstimate> {
    if (patch.estimatedValueSource === 'MANUAL') {
      return { source: 'MANUAL', value: normalizeEtpMoney(patch.estimatedTotalValue ?? '0') };
    }
    const link = await this.researches.linkOf(tx, etp.processId, patch.priceResearchId ?? '');
    if (link.kind !== 'ACTIVE') {
      throw validationError([
        {
          field: 'priceResearchId',
          code: link.kind === 'CANCELED' ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
          message: ETP_ESTIMATE_MESSAGES.priceResearchInvalid,
        },
      ]);
    }
    const total = link.summary.totalEstimatedValue;
    return {
      source: 'PRICE_RESEARCH',
      priceResearchId: link.summary.id,
      // FA-03: pesquisa ainda sem cálculo — o valor fica ausente até a primeira estatística.
      value: total === null ? null : normalizeEtpMoney(total),
    };
  }

  /** Grava condicionado à versão; corrida perdida → 412 com a versão vencedora. */
  private async persist(tx: TenantTx, next: Etp, expectedVersion: number): Promise<void> {
    try {
      await this.etps.updateHeader(tx, next, expectedVersion);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const latest = await this.etps.findById(tx, next.id);
      if (latest === null) throw etpNotFound();
      throw versionConflict(latest.version);
    }
  }

  /**
   * `document.draft_update` (lacuna 1 das US-022/023): origem, pesquisa, conclusão e parcelamento
   * com os valores anterior e novo; o valor estimado mascarado se sigiloso.
   */
  private async record(
    tx: TenantTx,
    saved: Etp,
    changes: readonly EtpHeaderChange[],
    view: EditableTypedDocument,
  ): Promise<void> {
    const auditChanges: AuditChange[] = changes.map((change) =>
      change.field === 'estimatedTotalValue' && view.isBudgetConfidential
        ? { path: change.field, old: MASKED, new: MASKED }
        : { path: change.field, old: change.old, new: change.new },
    );
    await this.audit.record(tx, {
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: saved.documentId,
      processId: saved.processId,
      changes: auditChanges,
      metadata: {
        documentCode: view.document.code,
        target: 'HEADER',
        fields: changes.map((change) => change.field),
        estimatedValueSource: saved.estimatedValueSource,
        priceResearchId: saved.priceResearchId,
        conclusion: saved.conclusion,
        parcelingDecision: saved.parcelingDecision,
        version: saved.version,
      },
    });
  }
}

/** V-08: 412 `VERSION_CONFLICT` com a versão atual do ETP (a tela oferece "Recarregar"). */
function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: ETP_ESTIMATE_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}
