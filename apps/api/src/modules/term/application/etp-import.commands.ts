import { TERM_IMPORT_MESSAGES, TermImportedFromEtp } from '@contrataflow/validation';
import type {
  TermDto,
  TermImportApply,
  TermImportField,
  TermImportPreviewDto,
  TermMeta,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { EtpHeaderRegistry } from '#shared/etp/etp-header.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { TERM_CLOCK, TERM_IMPORT_TOKEN_KEY, TERM_REPOSITORY, TERM_TRANSACTIONS } from './ports.js';
import type { TermClock, TermRepository, TermTransactions } from './ports.js';
import { toTermDto, toTermMeta } from './term.presenter.js';
import { termNotFound } from './term.queries.js';
import { openEditableTerm } from './update-term-header.command.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import {
  DocumentFacade,
  ImportedSectionRejectedError,
} from '../../document/application/document.facade.js';
import type {
  EditableTypedDocument,
  ImportableEtpSource,
} from '../../document/application/document.facade.js';
import {
  applyEtpFields,
  importFingerprint,
  importTokenExpiry,
  planEtpImport,
  selectImport,
  signImportToken,
  verifyImportToken,
} from '../domain/etp-import.js';
import type {
  EtpImportPlan,
  EtpImportSource,
  SelectedImport,
  TermImportTarget,
} from '../domain/etp-import.js';
import type { TermOfReference } from '../domain/term-of-reference.js';

/*
 * TRM-05/06 — Importar dados do ETP para o TR (US-037 · RN-TR-16..24). Os dois passos abrem o TR do
 * mesmo jeito, numa transação do tenant: TR (404) → documento travado, `TERM_UPDATE` + POL-02 —
 * custódia OU participação (403), processo editável (409), tipo na etapa (422), TR em
 * `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) → ETP não cancelado do processo (422
 * `ETP_REQUIRED_FOR_IMPORT`) → plano pelo `importMappings` da versão do template fixada (POL-09 no
 * valor) e a impressão digital do estado lido.
 *
 * - Prévia (TRM-05): somente leitura — devolve o plano e o `importToken` (HMAC, 15 min).
 * - Aplicação (TRM-06): `If-Match` do TR (412) → token (422 inválido/de outro TR; 410 vencido ou
 *   ETP/TR alterados desde a prévia — RN-TR-19) → seleção (422) → cabeçalho (`version + 1`) →
 *   seções e itens no documento + versão `IMPORT` (`DocumentVersionCreated`) → `term.import_etp`
 *   → `TermImportedFromEtp` (timeline `TERM_IMPORTED_FROM_ETP`) → commit. Sem notificação.
 *   Logs sem conteúdo de seções, valores nem especificações.
 */

/** Valor mascarado da estimativa sigilosa na auditoria (POL-09). */
const MASKED = '[MASKED]';

interface OpenedImport {
  readonly term: TermOfReference;
  readonly view: EditableTypedDocument;
  readonly masked: boolean;
  readonly etp: ImportableEtpSource;
  readonly source: EtpImportSource;
  readonly plan: EtpImportPlan;
  readonly fingerprint: string;
}

/** Abertura comum da prévia e da aplicação (ver o comentário do arquivo). */
@Injectable()
export class TermEtpImportReader {
  constructor(
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    private readonly documents: DocumentFacade,
    private readonly headers: EtpHeaderRegistry,
    private readonly calendar: BusinessCalendarFacade,
  ) {}

  async open(tx: TenantTx, termId: string, now: Date): Promise<OpenedImport> {
    const found = await this.terms.findById(tx, termId);
    if (found === null) throw termNotFound();
    const view = await openEditableTerm(this.documents, tx, found, TERM_IMPORT_MESSAGES);
    // Relido DEPOIS da trava do documento: a aplicação concorrente que venceu já gravou (412).
    const term = (await this.terms.findById(tx, termId)) ?? found;
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    const etp = await this.documents.importableEtpIn(tx, term.processId);
    if (etp === null) {
      throw new ApiError('ETP_REQUIRED_FOR_IMPORT', { detail: TERM_IMPORT_MESSAGES.etpRequired });
    }
    const header = await this.headers.headerOf(tx, etp.documentId);
    const source: EtpImportSource = {
      etpId: etp.documentId,
      code: etp.code,
      status: etp.status,
      versionId: etp.currentVersionId,
      versionNumber: etp.currentVersionNumber,
      documentVersion: etp.version,
      draftRevision: etp.draftRevision,
      sections: etp.sections,
      header:
        header === null
          ? null
          : {
              estimatedTotalValue: header.estimatedTotalValue,
              priceResearchId: header.priceResearchId,
              version: header.version,
            },
      items: etp.items,
    };
    const items = await this.documents.documentItemsIn(tx, term.documentId);
    const target: TermImportTarget = {
      term,
      templateVersionId: view.template?.id ?? null,
      templateSectionKeys: new Set((view.template?.sections ?? []).map((section) => section.key)),
      documentVersion: view.document.version,
      draftRevision: view.document.draftRevision,
      sections: view.document.draftContent.sections,
      items: items.map((item) => ({
        processItemId: item.processItemId,
        quantity: item.quantity,
        notes: item.notes,
      })),
      specified: await this.documents.specifiedItemsIn(tx, term.documentId),
      masked,
    };
    const plan = planEtpImport(view.template?.importMappings ?? null, source, target, {
      localDate: await this.calendar.localDate(tx, now),
    });
    return {
      term,
      view,
      masked,
      etp,
      source,
      plan,
      fingerprint: importFingerprint(source, target),
    };
  }
}

/** FA-02: o ETP ainda pode mudar. */
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'RETURNED', 'IN_REVIEW']);

function toPreviewDto(opened: OpenedImport, token: string, expiresAt: Date): TermImportPreviewDto {
  const { plan, etp } = opened;
  return {
    importToken: token,
    expiresAt: expiresAt.toISOString(),
    etp: {
      id: etp.documentId,
      code: etp.code,
      status: etp.status,
      versionNumber: etp.currentVersionNumber,
      inProgress: IN_PROGRESS_STATUSES.has(etp.status),
    },
    sections: plan.sections.map((section) => ({
      target: section.target,
      sources: [...section.sources],
      mode: section.mode,
      before: section.before,
      preview: section.preview,
    })),
    fields: plan.fields.map((field) => ({
      target: field.target,
      source: field.source,
      value: field.value,
      valueMasked: field.valueMasked,
      current: field.current,
    })),
    items: {
      count: plan.items.length,
      copyQuantities: plan.copyQuantities,
      copyCalculationMemoToNotes: plan.copyCalculationMemoToNotes,
      preview: plan.items.map((item) => ({
        processItemId: item.processItemId,
        sequence: item.sequence,
        description: item.description,
        etpQuantity: item.etpQuantity,
        trCurrentQuantity: item.trCurrentQuantity,
        specified: item.specified,
      })),
    },
    replacesPriceResearchValue: plan.replacesPriceResearchValue,
  };
}

/** TRM-05 — prévia somente leitura (RN-TR-18): nada é gravado, nenhum evento. */
@Injectable()
export class PreviewTermEtpImportQuery {
  constructor(
    @Inject(TERM_TRANSACTIONS) private readonly transactions: TermTransactions,
    @Inject(TERM_CLOCK) private readonly clock: TermClock,
    @Inject(TERM_IMPORT_TOKEN_KEY) private readonly tokenKey: Buffer,
    private readonly reader: TermEtpImportReader,
  ) {}

  execute(termId: string): Promise<TermImportPreviewDto> {
    // Transação de escrita só pela trava de linha da POL-02 (`FOR UPDATE`); nada é gravado.
    return this.transactions.run(async (tx) => {
      const now = this.clock();
      const opened = await this.reader.open(tx, termId, now);
      const expiresAt = importTokenExpiry(now);
      const token = signImportToken(
        {
          tenantId: opened.term.tenantId,
          termId: opened.term.id,
          etpId: opened.etp.documentId,
          etpVersionId: opened.etp.currentVersionId,
          fingerprint: opened.fingerprint,
          expiresAt,
        },
        this.tokenKey,
      );
      return toPreviewDto(opened, token, expiresAt);
    });
  }
}

export interface ApplyTermEtpImportInput {
  readonly termId: string;
  readonly expectedVersion: number;
  readonly body: TermImportApply;
  readonly idempotencyKey: string | null;
}

export interface AppliedTermEtpImport {
  readonly dto: TermDto;
  readonly meta: TermMeta;
  readonly sectionsImported: readonly string[];
  readonly fieldsImported: readonly TermImportField[];
  readonly itemsImported: number;
  readonly documentVersion: { readonly id: string; readonly versionNumber: number };
  readonly etpId: string;
  readonly etpVersionId: string | null;
}

/** TRM-06 — aplicação seletiva e rastreável (RN-TR-19..24). */
@Injectable()
export class ApplyTermEtpImportCommand extends TransactionalCommandHandler<
  ApplyTermEtpImportInput,
  undefined,
  AppliedTermEtpImport
> {
  private readonly staleLogger = new Logger('term.import');

  constructor(
    @Inject(TERM_TRANSACTIONS) transactions: TermTransactions,
    @Inject(TERM_REPOSITORY) private readonly terms: TermRepository,
    @Inject(TERM_CLOCK) private readonly clock: TermClock,
    @Inject(TERM_IMPORT_TOKEN_KEY) private readonly tokenKey: Buffer,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly documents: DocumentFacade,
    private readonly reader: TermEtpImportReader,
  ) {
    super('term.import', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: ApplyTermEtpImportInput,
  ): Promise<AppliedTermEtpImport> {
    const now = this.clock();
    const opened = await this.reader.open(tx, input.termId, now);
    const { term, view, masked, etp, plan } = opened;
    if (term.version !== input.expectedVersion) throw this.conflict(term.version);

    const check = verifyImportToken(input.body.importToken, this.tokenKey, {
      tenantId: term.tenantId,
      termId: term.id,
      now,
    });
    if (check.kind === 'INVALID') {
      throw validationError([
        {
          field: 'importToken',
          code: 'INVALID_FORMAT',
          message: TERM_IMPORT_MESSAGES.tokenInvalid,
        },
      ]);
    }
    if (check.kind === 'EXPIRED') throw this.stale(term.id, 'EXPIRED');
    if (check.claims.etpId !== etp.documentId || check.claims.fingerprint !== opened.fingerprint) {
      throw this.stale(term.id, 'SOURCE_CHANGED');
    }

    const selection = selectImport(plan, term, {
      sections: input.body.sections,
      fields: input.body.fields,
      copyItems: input.body.copyItems,
      overwriteExisting: input.body.overwriteExisting ?? false,
      confirmReplaceValueSource: input.body.confirmReplaceValueSource ?? false,
    });
    if (!selection.ok) throw validationError([...selection.errors]);
    const { selected } = selection;

    const actorId = requireRequestContext().actor.userId ?? '';
    const header = applyEtpFields(term, selected.fields, {
      etpId: etp.documentId,
      etpVersionId: etp.currentVersionId,
      actorId,
      now,
    });
    try {
      await this.terms.recordImport(tx, header.term, input.expectedVersion);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const latest = await this.terms.findById(tx, term.id);
      throw this.conflict(latest?.version ?? input.expectedVersion + 1);
    }
    const saved: TermOfReference = { ...header.term, version: input.expectedVersion + 1 };

    const imported = await this.importContent(tx, opened, selected);
    const sectionsImported = selected.sections.map((section) => section.target);
    const fieldsImported = selected.fields.map((field) => field.target);
    const itemsImported = imported.itemsWritten;

    await this.audit.record(tx, {
      action: 'term.import_etp',
      entityType: 'TermOfReference',
      entityId: term.id,
      processId: term.processId,
      changes: this.auditChanges(selected, header.changes, view.isBudgetConfidential),
      metadata: {
        documentCode: view.document.code,
        etpId: etp.documentId,
        etpCode: etp.code,
        etpVersionId: etp.currentVersionId,
        sectionsImported,
        fieldsImported,
        itemsImported,
        documentVersionId: imported.version.id,
        versionNumber: imported.version.versionNumber,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      TermImportedFromEtp.of({
        aggregateId: term.id,
        processId: term.processId,
        payload: {
          termId: term.id,
          etpId: etp.documentId,
          etpVersionId: etp.currentVersionId,
          sectionsImported,
          itemsImported,
        },
      }),
    );
    return {
      dto: toTermDto(saved, imported.document, view.template, { masked }),
      meta: toTermMeta(view.allowedActions),
      sectionsImported,
      fieldsImported,
      itemsImported,
      documentVersion: imported.version,
      etpId: etp.documentId,
      etpVersionId: etp.currentVersionId,
    };
  }

  protected override committed(result: AppliedTermEtpImport, durationMs: number): void {
    this.logger.log(
      {
        event: 'term.import_etp_applied',
        termId: result.dto.id,
        etpId: result.etpId,
        etpVersionId: result.etpVersionId,
        sectionsCount: result.sectionsImported.length,
        fieldsCount: result.fieldsImported.length,
        itemsCount: result.itemsImported,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'term.import_etp_applied',
    );
  }

  private async importContent(tx: TenantTx, opened: OpenedImport, selected: SelectedImport) {
    const { etp, plan, view } = opened;
    const versionLabel =
      etp.currentVersionNumber === null ? '' : ` (v${String(etp.currentVersionNumber)})`;
    try {
      return await this.documents.importIn(tx, {
        documentId: opened.term.documentId,
        sections: selected.sections.map((section) => ({
          key: section.target,
          content: section.content,
          ai: section.ai,
        })),
        items: selected.items.map((item) => ({
          processItemId: item.processItemId,
          quantity: item.etpQuantity,
          replaceQuantity: plan.copyQuantities,
          ...(item.notes === undefined ? {} : { notes: item.notes }),
        })),
        changeSummary: `Importação do ${etp.code ?? 'ETP'}${versionLabel}`,
      });
    } catch (error) {
      if (!(error instanceof ImportedSectionRejectedError)) throw error;
      const title =
        view.template?.sections.find((section) => section.key === error.sectionKey)?.title ??
        error.sectionKey;
      throw validationError([
        {
          field: 'sections',
          code: error.problem.kind === 'TOO_LONG' ? 'TOO_LONG' : 'NOT_ALLOWED',
          message: TERM_IMPORT_MESSAGES.sectionTooLong(title),
        },
      ]);
    }
  }

  /** Chaves alteradas, sem conteúdo (valor mascarado em processo sigiloso). */
  private auditChanges(
    selected: SelectedImport,
    headerChanges: ReturnType<typeof applyEtpFields>['changes'],
    confidential: boolean,
  ): AuditChange[] {
    return [
      ...selected.sections.map((section) => ({
        path: `sections.${section.target}`,
        old: null,
        new: section.mode,
      })),
      ...headerChanges.map((change) =>
        change.field === 'estimatedTotalValue' && confidential
          ? { path: change.field, old: MASKED, new: MASKED }
          : { path: change.field, old: change.old, new: change.new },
      ),
      ...selected.items.map((item) => ({
        path: `items.${item.processItemId}.quantity`,
        old: item.trCurrentQuantity,
        new: item.etpQuantity,
      })),
    ];
  }

  /** RN-TR-19: token vencido ou origem/destino alterados desde a prévia → 410. */
  private stale(termId: string, reason: 'EXPIRED' | 'SOURCE_CHANGED'): ApiError {
    this.staleLogger.warn(
      {
        event: 'term.import_preview_stale',
        termId,
        reason,
        correlationId: requireRequestContext().correlationId,
      },
      'term.import_preview_stale',
    );
    return new ApiError('IMPORT_PREVIEW_EXPIRED', { detail: TERM_IMPORT_MESSAGES.expired });
  }

  /** 412 `VERSION_CONFLICT`: o TR mudou desde que a tela o leu. */
  private conflict(currentVersion: number): ApiError {
    return new ApiError('VERSION_CONFLICT', {
      detail: TERM_IMPORT_MESSAGES.versionConflict,
      extensions: { currentVersion },
    });
  }
}
