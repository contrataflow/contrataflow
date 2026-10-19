import { createHash } from 'node:crypto';

import {
  ETP_ALTERNATIVE_MESSAGES,
  EtpAlternativeRecommended,
  richTextPlainText,
} from '@contrataflow/validation';
import type { EtpAlternativeDto, RichTextDocValue } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { etpNotFound } from './etp.queries.js';
import { ETP_ALTERNATIVE_REPOSITORY, ETP_REPOSITORY } from './ports.js';
import type { EtpAlternativeRepository, EtpRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { TypedDocumentView } from '../../document/application/document.facade.js';
import type { AlternativeChange, EtpAlternative } from '../domain/etp-alternative.js';
import type { Etp } from '../domain/etp.js';

/*
 * Peças comuns dos casos de uso das alternativas (US-021): a guarda (POL-02 estendida às coleções
 * tipadas — `ETP_UPDATE` + custódia/participação + processo editável + tipo na etapa + ETP em
 * `DRAFT`/`RETURNED` —, pela fachada do `document`, que trava o documento ETP no `tx`), o POL-09 do
 * custo (RN-ETP-24), o apresentador, os erros da story e a gravação dos efeitos na mesma transação
 * (auditoria `etp.alternative_*` e `EtpAlternativeRecommended`, que projeta a timeline).
 */

const COLLECTION = {
  systemModule: 'ETP',
  deniedDetail: ETP_ALTERNATIVE_MESSAGES.permissionDenied,
  lockedDetail: ETP_ALTERNATIVE_MESSAGES.notEditable,
} as const;

/** Processo não visível = o recurso "não existe" (404 indistinguível — DEC-024). */
const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND';

// --- Erros --------------------------------------------------------------------------------------

/** 404 de alternativa inexistente, excluída, de outro tenant ou de processo não visível. */
export function alternativeNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: ETP_ALTERNATIVE_MESSAGES.notFound });
}

/** V-09: 412 `VERSION_CONFLICT` com a versão atual (`currentVersion`). */
export function alternativeVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: ETP_ALTERNATIVE_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** V-03: 422 `VALIDATION_ERROR` com `DUPLICATE_IN_LIST` em `name`. */
export function duplicateName(): ApiError {
  return validationError([
    { field: 'name', code: 'DUPLICATE_IN_LIST', message: ETP_ALTERNATIVE_MESSAGES.nameDuplicate },
  ]);
}

/** V-05 (RN-ETP-20): 409 com a recomendada atual (a UI oferece "Substituir recomendação"). */
export function recommendedExists(recommendedAlternativeId: string | null): ApiError {
  return new ApiError('RECOMMENDED_ALTERNATIVE_EXISTS', {
    detail: ETP_ALTERNATIVE_MESSAGES.recommendedExists,
    extensions: recommendedAlternativeId === null ? {} : { meta: { recommendedAlternativeId } },
  });
}

/** V-06 (RN-ETP-22 · FA-03): 409 `INVALID_STATE` ao excluir a recomendada corrente. */
export function cannotDeleteRecommended(): ApiError {
  return new ApiError('INVALID_STATE', {
    detail: ETP_ALTERNATIVE_MESSAGES.deleteRecommended,
    extensions: { currentDecision: 'RECOMMENDED' },
  });
}

/** POL-09 (RN-ETP-24): quem não vê o custo de processo sigiloso também não o altera. */
export function confidentialCostDenied(): ApiError {
  return new ApiError('PERMISSION_DENIED', { detail: ETP_ALTERNATIVE_MESSAGES.confidentialCost });
}

// --- Métricas -----------------------------------------------------------------------------------

let changedCounter: Counter | undefined;

/** `etp_alternative_changed_total{change}` — criadas, editadas, excluídas e decididas. */
export function countAlternativeChanged(
  change: 'CREATED' | 'UPDATED' | 'DELETED' | 'RECOMMENDED' | 'DISCARDED' | 'UNDER_ANALYSIS',
): void {
  changedCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('etp_alternative_changed_total', {
      description: 'Mudanças nas alternativas de solução do ETP, por tipo.',
    });
  changedCounter.add(1, { change });
}

// --- Guarda -------------------------------------------------------------------------------------

/** O ETP lido com a visibilidade do processo, o POL-09 e se o usuário pode alterar a coleção. */
export interface EtpAlternativesRead {
  readonly etp: Etp;
  readonly view: TypedDocumentView;
  /** POL-09: processo sigiloso sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia. */
  readonly masked: boolean;
  readonly canManage: boolean;
}

/** O ETP aberto para gravar a coleção (POL-02 conferida, documento travado). */
export interface EtpAlternativesWrite {
  readonly etp: Etp;
  readonly masked: boolean;
}

export interface AlternativeWrite extends EtpAlternativesWrite {
  readonly alternative: EtpAlternative;
}

@Injectable()
export class EtpAlternativeGate {
  constructor(
    @Inject(ETP_REPOSITORY) private readonly etps: EtpRepository,
    @Inject(ETP_ALTERNATIVE_REPOSITORY) private readonly alternatives: EtpAlternativeRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /** ETP-05: visibilidade do processo do ETP (404 `NOT_FOUND`), POL-09 e as ações da tela. */
  async readable(tx: TenantTx, etpId: string): Promise<EtpAlternativesRead> {
    const etp = await this.etps.findById(tx, etpId);
    if (etp === null) throw etpNotFound();
    const view = await this.documents.typedDocumentIn(tx, etp.documentId);
    if (view === null) throw etpNotFound();
    const state = await this.documents.typedCollectionStateIn(tx, {
      processId: etp.processId,
      ...COLLECTION,
    });
    return {
      etp,
      view,
      masked: view.isBudgetConfidential && !view.canViewConfidentialBudget,
      // Só o ETP ativo do processo (não cancelado) aceita alterações.
      canManage: state.lockReason === null && state.owner?.id === etp.documentId,
    };
  }

  /**
   * ETP-06: o ETP (404), a POL-02 estendida — 403 `PERMISSION_DENIED` com `access.denied`, 409
   * `INVALID_PROCESS_STATUS`, 422 de etapa, 409 `DOCUMENT_NOT_EDITABLE` (V-08) — e o POL-09. O
   * documento ETP fica travado até o fim do `tx`: decisões concorrentes se enfileiram (RN-ETP-20).
   */
  async writableEtp(tx: TenantTx, etpId: string): Promise<EtpAlternativesWrite> {
    const etp = await this.etps.findById(tx, etpId);
    if (etp === null) throw etpNotFound();
    return this.authorize(tx, etp, etpNotFound);
  }

  /** ETP-07/08/09: a alternativa (404), a guarda do ETP dela e a alternativa relida após a trava. */
  async writableAlternative(tx: TenantTx, alternativeId: string): Promise<AlternativeWrite> {
    const found = await this.alternatives.findById(tx, alternativeId);
    if (found === null) throw alternativeNotFound();
    const etp = await this.etps.findById(tx, found.etpId);
    if (etp === null) throw alternativeNotFound();
    const write = await this.authorize(tx, etp, alternativeNotFound);
    // Relida depois da trava do documento: a versão conferida pelo `If-Match` é a vigente.
    const alternative = await this.alternatives.findById(tx, alternativeId);
    if (alternative === null) throw alternativeNotFound();
    return { ...write, alternative };
  }

  private async authorize(
    tx: TenantTx,
    etp: Etp,
    notFound: () => ApiError,
  ): Promise<EtpAlternativesWrite> {
    let owner;
    try {
      ({ owner } = await this.documents.assertTypedCollectionWritableIn(tx, {
        processId: etp.processId,
        ...COLLECTION,
      }));
    } catch (error) {
      if (isNotFound(error)) throw notFound();
      throw error;
    }
    // ETP cancelado (o ativo do processo é outro ou nenhum): FA-05 — somente leitura.
    if (owner?.id !== etp.documentId) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: ETP_ALTERNATIVE_MESSAGES.notEditable,
        extensions: { meta: { documentId: etp.documentId } },
      });
    }
    const view = await this.documents.typedDocumentIn(tx, etp.documentId);
    if (view === null) throw notFound();
    // Relido depois da trava: a recomendada do cabeçalho é a vigente.
    const current = await this.etps.findById(tx, etp.id);
    if (current === null) throw notFound();
    return {
      etp: current,
      masked: view.isBudgetConfidential && !view.canViewConfidentialBudget,
    };
  }
}

// --- Apresentação -------------------------------------------------------------------------------

/** `EtpAlternative` (ETP-05..09). POL-09: `estimatedCost = null` + `estimatedCostMasked: true`. */
export function toAlternativeDto(
  alternative: EtpAlternative,
  options: { readonly masked: boolean },
): EtpAlternativeDto {
  return {
    id: alternative.id,
    etpId: alternative.etpId,
    processId: alternative.processId,
    name: alternative.name,
    description: alternative.description,
    advantages: alternative.advantages,
    disadvantages: alternative.disadvantages,
    estimatedCost: options.masked ? null : alternative.estimatedCost,
    estimatedCostMasked: options.masked,
    riskLevel: alternative.riskLevel,
    observations: alternative.observations,
    sortOrder: alternative.sortOrder,
    decision: alternative.decision,
    decisionJustification: alternative.decisionJustification,
    createdAt: alternative.createdAt.toISOString(),
    updatedAt: alternative.updatedAt.toISOString(),
    version: alternative.version,
  };
}

// --- Auditoria e eventos ------------------------------------------------------------------------

/** Textos longos (rich text e texto livre): na auditoria, só hash + tamanho (story · "Auditoria"). */
const LONG_TEXT = new Set([
  'description',
  'advantages',
  'disadvantages',
  'observations',
  'decisionJustification',
]);

function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

function audited(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  // Custo estimado é sigiloso (POL-09): a auditoria registra só que mudou.
  if (field === 'estimatedCost') return '[sigiloso]';
  if (!LONG_TEXT.has(field)) return value;
  const text = typeof value === 'string' ? value : richTextPlainText(value as RichTextDocValue);
  return fingerprint(text);
}

const toAuditChanges = (changes: readonly AlternativeChange[]): AuditChange[] =>
  changes.map((change) => ({
    path: change.field,
    old: audited(change.field, change.old),
    new: audited(change.field, change.new),
  }));

@Injectable()
export class EtpAlternativeRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** `etp.alternative_create`: nome e risco; textos longos como hash + tamanho (sem evento). */
  async created(tx: TenantTx, alternative: EtpAlternative): Promise<void> {
    const changes: AlternativeChange[] = [
      { field: 'name', old: null, new: alternative.name },
      { field: 'riskLevel', old: null, new: alternative.riskLevel },
      { field: 'description', old: null, new: alternative.description },
      ...(['advantages', 'disadvantages', 'observations', 'estimatedCost'] as const)
        .filter((field) => alternative[field] !== null)
        .map((field) => ({ field, old: null, new: alternative[field] })),
    ];
    await this.audit.record(tx, {
      action: 'etp.alternative_create',
      entityType: 'EtpAlternative',
      entityId: alternative.id,
      processId: alternative.processId,
      changes: toAuditChanges(changes),
      metadata: { etpId: alternative.etpId, sortOrder: alternative.sortOrder },
    });
  }

  /** `etp.alternative_update`: os campos alterados. */
  async updated(
    tx: TenantTx,
    alternative: EtpAlternative,
    changes: readonly AlternativeChange[],
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'etp.alternative_update',
      entityType: 'EtpAlternative',
      entityId: alternative.id,
      processId: alternative.processId,
      changes: toAuditChanges(changes),
      metadata: { etpId: alternative.etpId, version: alternative.version },
    });
  }

  /** `etp.alternative_delete`: exclusão lógica (`metadata.alternativeId`). */
  async deleted(tx: TenantTx, alternative: EtpAlternative): Promise<void> {
    await this.audit.record(tx, {
      action: 'etp.alternative_delete',
      entityType: 'EtpAlternative',
      entityId: alternative.id,
      processId: alternative.processId,
      metadata: { etpId: alternative.etpId, alternativeId: alternative.id },
    });
  }

  /**
   * `etp.alternative_decide` (`decision`, `replaceRecommended`, `previousAlternativeId?`) e, na
   * recomendação nova, `EtpAlternativeRecommended` (timeline `ETP_ALTERNATIVE_RECOMMENDED`).
   */
  async decided(
    tx: TenantTx,
    alternative: EtpAlternative,
    decision: {
      readonly changes: readonly AlternativeChange[];
      readonly replaceRecommended: boolean;
      readonly previousAlternativeId: string | null;
      readonly recommended: boolean;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'etp.alternative_decide',
      entityType: 'EtpAlternative',
      entityId: alternative.id,
      processId: alternative.processId,
      changes: toAuditChanges(decision.changes),
      metadata: {
        etpId: alternative.etpId,
        decision: alternative.decision,
        replaceRecommended: decision.replaceRecommended,
        ...(decision.previousAlternativeId === null
          ? {}
          : { previousAlternativeId: decision.previousAlternativeId }),
      },
    });
    if (!decision.recommended) return;
    await this.outbox.record(
      tx,
      EtpAlternativeRecommended.of({
        aggregateId: alternative.etpId,
        processId: alternative.processId,
        payload: {
          etpId: alternative.etpId,
          alternativeId: alternative.id,
          ...(decision.previousAlternativeId === null
            ? {}
            : { previousAlternativeId: decision.previousAlternativeId }),
        },
      }),
    );
  }
}
