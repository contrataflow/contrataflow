import { performance } from 'node:perf_hooks';

import { AUDIT_SEAL_MESSAGES, sealPeriodsIn } from '@contrataflow/validation';
import type {
  AuditSealDto,
  AuditSealListQuery,
  AuditSealVerification,
  VerifyAuditSeals,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { pageResult, pageWindow } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';

import { auditSealMetrics } from './audit-telemetry.js';
import { AUDIT_SEAL_STORE, AUDIT_TRANSACTIONS } from './ports.js';
import type { AuditSealStore, AuditTransactions } from './ports.js';
import { rowHashOf } from '../domain/audit-record.js';
import { SealChainVerifier, sealPeriodOf } from '../domain/audit-seal.js';
import type { AuditSeal, SealCheck } from '../domain/audit-seal.js';

function tenantOfContext(): string {
  const { tenantId } = requireRequestContext();
  if (tenantId === null) throw new Error('Selos de auditoria exigem o tenant do contexto.');
  return tenantId;
}

export function toAuditSealDto(seal: AuditSeal): AuditSealDto {
  return {
    id: seal.id,
    periodStart: seal.periodStart.toISOString(),
    periodEnd: seal.periodEnd.toISOString(),
    recordCount: seal.recordCount,
    digest: seal.digest,
    chainHash: seal.chainHash,
    sealedAt: seal.sealedAt.toISOString(),
  };
}

/** Banco fora do ar → 503 `DEPENDENCY_UNAVAILABLE`; erro de contrato segue como está. */
function mapFailure(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  return isTransientDatabaseError(error) ? new DatabaseUnavailableError(error) : error;
}

/**
 * `GetAuditSealsHandler` — AUD-04 (US-074): selos do tenant, mais recentes primeiro, por página,
 * com filtro opcional de período sobre `periodStart`. `AUDIT_VIEW` (e MFA — POL-14) já conferidos
 * pelo guard. A consulta é auditada como `audit.search` (ACCESS) com os filtros de período.
 */
@Injectable()
export class GetAuditSealsHandler {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SEAL_STORE) private readonly seals: AuditSealStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async execute(query: AuditSealListQuery): Promise<PageResult<AuditSealDto>> {
    const tenantId = tenantOfContext();
    const window = pageWindow(query, this.config.pagination.maxPageSize);
    try {
      const { items, total } = await this.transactions.read((tx) =>
        this.seals.list(tx, {
          tenantId,
          periodFrom: query.periodFrom === undefined ? null : new Date(query.periodFrom),
          periodTo: query.periodTo === undefined ? null : new Date(query.periodTo),
          skip: window.skip,
          take: window.take,
        }),
      );
      await this.audit.recordStandalone({
        action: 'audit.search',
        metadata: {
          target: 'seals',
          periodFrom: query.periodFrom ?? null,
          periodTo: query.periodTo ?? null,
          page: window.page,
        },
      });
      return pageResult(items.map(toAuditSealDto), window, total);
    } catch (error) {
      throw mapFailure(error);
    }
  }
}

/**
 * `VerifyAuditSealsHandler` — AUD-05 (US-074 · RN-AUD-15/16): recalcula, selo a selo e em ordem, o
 * `digest` a partir dos registros ATUAIS de cada período (com o `rowHash` recalculado do conteúdo,
 * não o gravado — uma linha alterada no banco aparece mesmo se a coluna `row_hash` ficou intacta)
 * e o `chainHash` a partir do antecessor real. Somente leitura: nada é gravado nem publicado.
 */
@Injectable()
export class VerifyAuditSealsHandler {
  private readonly logger = new Logger('AuditSeal');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SEAL_STORE) private readonly seals: AuditSealStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
  ) {}

  async execute(body: VerifyAuditSeals): Promise<AuditSealVerification> {
    const maxPeriods = this.config.audit.sealVerificationMaxPeriods;
    // V-01 (FA-04): conta as horas cheias do intervalo — o teto de selos que ele pode conter.
    if (sealPeriodsIn(body.periodStart, body.periodEnd) > maxPeriods) {
      throw validationError([
        {
          field: 'periodEnd',
          code: 'OUT_OF_RANGE',
          message: AUDIT_SEAL_MESSAGES.tooManyPeriods(maxPeriods),
        },
      ]);
    }
    const tenantId = tenantOfContext();
    const started = performance.now();
    try {
      const verification = await this.transactions.read(async (tx) => {
        const seals = await this.seals.findInRange(tx, {
          tenantId,
          from: sealPeriodOf(new Date(body.periodStart)).start,
          to: new Date(body.periodEnd),
          limit: maxPeriods,
        });
        const [first] = seals;
        // V-04: nenhum selo deste tenant no intervalo (o de outro tenant é invisível pela RLS).
        if (first === undefined) {
          throw new ApiError('NOT_FOUND', { detail: AUDIT_SEAL_MESSAGES.notFound });
        }
        const predecessor = await this.seals.findPredecessor(tx, tenantId, first.periodStart);
        const checks: SealCheck[] = [];
        for (const seal of seals) {
          const records = await this.seals.periodRecords(tx, tenantId, {
            start: seal.periodStart,
            end: seal.periodEnd,
          });
          checks.push({
            seal,
            records: records.map((record) => ({ id: record.id, rowHash: rowHashOf(record) })),
          });
        }
        return SealChainVerifier.verify(predecessor, checks);
      });
      const durationMs = Math.round(performance.now() - started);
      const broken = verification.results.filter((result) => result.status === 'INVALID');
      for (const result of broken) {
        this.logger.warn(
          {
            event: 'audit.seal_verification_broken',
            alert: true,
            tenantId,
            periodStart: result.periodStart.toISOString(),
            brokenAt: result.brokenAt,
          },
          'audit.seal_verification_broken',
        );
      }
      auditSealMetrics().verifications.add(1, { result: broken.length > 0 ? 'INVALID' : 'VALID' });
      this.logger.log(
        {
          event: 'audit.seal_verified',
          tenantId,
          seals: verification.results.length,
          invalid: broken.length,
          durationMs,
        },
        'audit.seal_verified',
      );
      return {
        brokenAtPeriodStart: verification.brokenAtPeriodStart?.toISOString() ?? null,
        results: verification.results.map((result) => ({
          periodStart: result.periodStart.toISOString(),
          periodEnd: result.periodEnd.toISOString(),
          recordCount: result.recordCount,
          status: result.status,
          ...(result.brokenAt === undefined ? {} : { brokenAt: result.brokenAt }),
        })),
      };
    } catch (error) {
      throw mapFailure(error);
    }
  }
}
