import { AI_AVAILABILITY_REASONS } from '@contrataflow/types';
import type { AiAvailabilityReason } from '@contrataflow/types';
import { AI_USAGE_MESSAGES } from '@contrataflow/validation';
import type {
  AiAvailabilityDto,
  AiAvailabilityQuery,
  AiUsageDto,
  AiUsageQuery,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { AiCircuitBreaker } from './ai-circuit-breaker.js';
import { AiTenantGateService } from './ai-tenant-gate.service.js';
import { AI_CLOCK, AI_SETTINGS, AI_TRANSACTIONS } from './ports.js';
import type { AiClock, AiSettings, AiTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  AI_MIN_RESERVATION,
  percentUsed,
  usageBreakdown,
  usageDayOf,
  usageMonthOf,
  userDailyCount,
} from '../domain/ai-usage.js';

/*
 * AI-05 e AI-06 (US-116 · RN-AI-23 · api/16-ai.md):
 *
 * - AI-05 (capacidade implícita): se o usuário pode gerar agora — IA ligada, provedor disponível,
 *   `AI_GENERATE` (no processo, quando informado; senão em algum escopo), documento editável por
 *   ele e limites do mês e do dia. É INDICATIVO (sem trava): AI-01 decide. Tokens absolutos só
 *   para quem tem `SETTINGS_MANAGE`. Processo/documento de outro tenant ou não visível → 404.
 * - AI-06 (`SETTINGS_MANAGE` + MFA — POL-14): consumo do mês com tokens, custo e a divisão por
 *   tipo de documento, tipo de geração e usuário. Leitura administrativa, não auditada.
 */

/** Recusas do alvo (`DocumentFacade.aiTargetIn`) que significam "não editável por você agora". */
const NOT_EDITABLE_CODES: ReadonlySet<string> = new Set([
  'DOCUMENT_NOT_EDITABLE',
  'INVALID_PROCESS_STATUS',
  'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
  'NOT_PROCESS_CUSTODIAN',
]);

function processNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Processo não encontrado.' });
}

@Injectable()
export class AiUsageQueries {
  constructor(
    @Inject(AI_TRANSACTIONS) private readonly transactions: AiTransactions,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    private readonly gate: AiTenantGateService,
    private readonly circuit: AiCircuitBreaker,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly documents: DocumentFacade,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async availability(query: AiAvailabilityQuery): Promise<AiAvailabilityDto> {
    if (query.documentId !== undefined && query.processId === undefined) {
      throw validationError([
        {
          field: 'processId',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Informe o processo do documento.',
        },
      ]);
    }
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const providerAvailable =
      this.settings.provider !== 'none' && !(await this.circuit.view()).open;

    return this.transactions.read(async (tx) => {
      const reasons = new Set<AiAvailabilityReason>(await this.targetReasons(tx, query));
      const now = this.clock();
      const { settings, usage, rows, timeZone } = await this.gate.snapshot(tx, now);
      const used = userDailyCount(rows, userId, usageDayOf(now, timeZone), timeZone);
      if (!settings.enabled) reasons.add('AI_DISABLED');
      if (!providerAvailable) reasons.add('AI_PROVIDER_UNAVAILABLE');
      if (
        usage.usedTokens + usage.reservedTokens + AI_MIN_RESERVATION >
        settings.monthlyTokenLimit
      ) {
        reasons.add('AI_USAGE_LIMIT_REACHED');
      }
      if (used >= settings.userDailyRequestLimit) reasons.add('AI_USER_DAILY_LIMIT_REACHED');

      const ordered = AI_AVAILABILITY_REASONS.filter((reason) => reasons.has(reason));
      const absolute = this.access.can('SETTINGS_MANAGE');
      return {
        enabled: settings.enabled,
        providerAvailable,
        canGenerate: ordered.length === 0,
        reasons: ordered,
        monthly: {
          percentUsed: percentUsed(usage.usedTokens, settings.monthlyTokenLimit),
          ...(absolute
            ? { usedTokens: usage.usedTokens, limitTokens: settings.monthlyTokenLimit }
            : {}),
        },
        userDaily: { used, limit: settings.userDailyRequestLimit },
      };
    });
  }

  async usage(query: AiUsageQuery): Promise<AiUsageDto> {
    this.access.assertCan('SETTINGS_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    return this.transactions.read(async (tx) => {
      const now = this.clock();
      const current = usageMonthOf(now, await this.gate.timeZone(tx));
      const month = query.month ?? current;
      if (month > current) {
        throw validationError([
          { field: 'month', code: 'OUT_OF_RANGE', message: AI_USAGE_MESSAGES.month },
        ]);
      }
      const { settings, rows } = await this.gate.snapshot(tx, now, month);
      const breakdown = usageBreakdown(rows);
      const names = await this.identity.userDisplayNames(
        tx,
        breakdown.byUser.map((entry) => entry.userId),
      );
      return {
        month,
        limitTokens: settings.monthlyTokenLimit,
        usedTokens: breakdown.usedTokens,
        reservedTokens: breakdown.reservedTokens,
        costUsd: breakdown.costUsd,
        generations: breakdown.generations,
        byDocumentType: breakdown.byDocumentType,
        byKind: breakdown.byKind,
        byUser: breakdown.byUser.map((entry) => ({
          ...entry,
          name: names.get(entry.userId) ?? '',
        })),
      };
    });
  }

  /** Permissão e alvo: `PERMISSION_DENIED`/`DOCUMENT_NOT_EDITABLE`; fora do tenant → 404. */
  private async targetReasons(
    tx: TenantTx,
    query: AiAvailabilityQuery,
  ): Promise<AiAvailabilityReason[]> {
    if (query.processId === undefined) {
      return this.access.can('AI_GENERATE') ? [] : ['PERMISSION_DENIED'];
    }
    const process = await this.processes.load(tx, query.processId);
    if (
      process === null ||
      !isProcessVisible(await this.access.processVisibilityScope(), process.access)
    ) {
      throw processNotFound();
    }
    if (!(await this.access.canOnProcess('AI_GENERATE', process.access))) {
      return ['PERMISSION_DENIED'];
    }
    if (query.documentId === undefined) return [];
    try {
      await this.documents.aiTargetIn(tx, {
        processId: query.processId,
        systemModule: null,
        documentId: query.documentId,
      });
      return [];
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'VALIDATION_ERROR') throw processNotFound();
      if (NOT_EDITABLE_CODES.has(error.code)) return ['DOCUMENT_NOT_EDITABLE'];
      if (error.status === 403) return ['PERMISSION_DENIED'];
      throw error;
    }
  }
}
