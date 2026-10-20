import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import {
  WORKFLOW_CLOCK,
  WORKFLOW_REPOSITORY,
  WORKFLOW_TRANSACTIONS,
  WorkflowImmutableError,
} from './ports.js';
import type { WorkflowClock, WorkflowRepository, WorkflowTransactions } from './ports.js';
import { workflowVersionNotDraft, workflowVersionNotFound } from './workflow.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { WorkflowVersion } from '../domain/workflow-definition.js';

export type DraftEntityType = 'WorkflowStage' | 'WorkflowTransition' | 'WorkflowRule';

/** Evento de log `info` por item salvo no rascunho (US-043 · Logs). */
const SAVED_EVENT: Readonly<Record<DraftEntityType, string>> = {
  WorkflowStage: 'workflow.stage_saved',
  WorkflowTransition: 'workflow.transition_saved',
  WorkflowRule: 'workflow.rule_saved',
};
export type DraftOperation = 'CREATE' | 'UPDATE' | 'DELETE';

export interface DraftEdit<T> {
  readonly result: T;
  /** `false` = nada mudou: sem incremento da versão nem auditoria. */
  readonly written: boolean;
  readonly entityType: DraftEntityType;
  readonly entityId: string;
  readonly operation: DraftOperation;
  readonly changes: readonly AuditChange[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Etapa inicial derivada depois da escrita (RN-WF-07); `undefined` = inalterada. */
  readonly initialStageId?: string | null;
}

export interface DraftContext {
  readonly tx: TenantTx;
  readonly version: WorkflowVersion;
  readonly now: Date;
  readonly userId: string | null;
}

/** Como achar a versão do item editado: o id dela (WF-10/13/16) ou o item (WF-11/12, 14/15, 17/18). */
export type DraftLocator = string | ((tx: TenantTx) => Promise<string>);

/** Valor de auditoria de uma expressão/configuração: hash e tamanho, nunca o conteúdo. */
export function auditDigest(value: unknown): { readonly sha256: string; readonly size: number } {
  const text = canonicalJson(value);
  return { sha256: sha256Hex(text), size: Buffer.byteLength(text, 'utf8') };
}

/** Campos alterados (RN-AUD-03), com `config` como hash + tamanho. */
export function changedFields<T extends object>(
  before: T | null,
  after: T | null,
  fields: readonly (keyof T & string)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    const old = before ? before[field] : null;
    const next = after ? after[field] : null;
    if (canonicalJson(old ?? null) === canonicalJson(next ?? null)) continue;
    changes.push(
      field === 'config'
        ? {
            path: field,
            old: old === null || old === undefined ? null : auditDigest(old),
            new: next === null || next === undefined ? null : auditDigest(next),
          }
        : { path: field, old: old ?? null, new: next ?? null },
    );
  }
  return changes;
}

/**
 * Escrita no rascunho (US-040 · RN-WF-05/06 · V-08): autoriza (`WORKFLOW_MANAGE` + MFA — POL-14),
 * abre a transação, trava a versão com `SELECT … FOR UPDATE` (serializa edições e a publicação),
 * confere `DRAFT` (409 `WORKFLOW_VERSION_NOT_DRAFT`), executa a escrita, incrementa
 * `WorkflowVersion.version` com a etapa inicial derivada e grava `workflow.update` com `entityType`
 * — tudo atômico. Os gatilhos do banco barram o que escapar daqui (log `error`).
 */
@Injectable()
export class WorkflowDraftEditor {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(WORKFLOW_TRANSACTIONS) private readonly transactions: WorkflowTransactions,
    @Inject(WORKFLOW_CLOCK) private readonly clock: WorkflowClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  /** `WORKFLOW_MANAGE` (risco `H`: segundo fator conforme `security.mfaPolicy`). */
  async authorize(): Promise<void> {
    this.access.assertCan('WORKFLOW_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
  }

  async edit<T>(
    locator: DraftLocator,
    work: (context: DraftContext) => Promise<DraftEdit<T>>,
  ): Promise<T> {
    await this.authorize();
    const context = requireRequestContext();
    const now = this.clock();
    let versionId = typeof locator === 'string' ? locator : null;
    const saved: {
      current: { entityType: DraftEntityType; entityId: string; operation: DraftOperation } | null;
    } = { current: null };
    try {
      const result = await this.transactions.run(async (tx) => {
        versionId = typeof locator === 'string' ? locator : await locator(tx);
        const version = await this.workflows.lockVersion(tx, versionId);
        if (!version) throw workflowVersionNotFound();
        if (version.status !== 'DRAFT') throw workflowVersionNotDraft(version.id);
        const userId = context.actor.userId;
        const edit = await work({ tx, version, now, userId });
        if (!edit.written) return edit.result;
        await this.workflows.touchVersion(tx, version.id, {
          initialStageId:
            edit.initialStageId === undefined ? version.initialStageId : edit.initialStageId,
          now,
          userId,
        });
        await this.audit.record(tx, {
          action: 'workflow.update',
          entityType: edit.entityType,
          entityId: edit.entityId,
          changes: edit.changes,
          metadata: {
            ...edit.metadata,
            workflowId: version.workflowId,
            workflowVersionId: version.id,
            operation: edit.operation,
          },
        });
        saved.current = {
          entityType: edit.entityType,
          entityId: edit.entityId,
          operation: edit.operation,
        };
        return edit.result;
      });
      if (saved.current) {
        const { entityType, entityId, operation } = saved.current;
        this.logger.log(
          {
            event: SAVED_EVENT[entityType],
            workflowVersionId: versionId,
            entityType,
            entityId,
            operation,
            tenantId: context.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          SAVED_EVENT[entityType],
        );
      }
      return result;
    } catch (error) {
      if (error instanceof WorkflowImmutableError) {
        this.logger.error(
          {
            event: 'workflow.immutability_violation_attempt',
            table: error.table,
            workflowVersionId: versionId,
            tenantId: context.tenantId,
            correlationId: context.correlationId,
          },
          'workflow.immutability_violation_attempt',
        );
        throw workflowVersionNotDraft(versionId ?? '');
      }
      if (!(error instanceof ApiError) || error.status >= 500) {
        // Falha de infraestrutura (banco, bug): a resposta sai pelo filtro; aqui só a causa.
        this.logger.error(
          {
            event: 'workflow.write_failed',
            workflowVersionId: versionId,
            cause:
              error instanceof ApiError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : 'unknown',
            tenantId: context.tenantId,
            correlationId: context.correlationId,
          },
          'workflow.write_failed',
        );
      }
      throw error;
    }
  }
}
