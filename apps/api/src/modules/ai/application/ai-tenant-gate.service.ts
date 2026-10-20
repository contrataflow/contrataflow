import { AiUsageThresholdReached } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { naturalKeyId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import type { AiGateDecision, AiGateRequest, AiTenantGate } from './ai-extension-points.js';
import { AI_CLOCK, AI_GENERATION_REPOSITORY } from './ports.js';
import type { AiClock, AiGenerationRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import {
  crossedThresholds,
  executionLimitDenial,
  monthlyUsage,
  monthQueryWindow,
  monthStartUtc,
  requestLimitDenial,
  rowsOfMonth,
  usageDayOf,
  usageMonthOf,
  userDailyCount,
} from '../domain/ai-usage.js';
import type { AiLimits, AiUsageRow, MonthlyUsage } from '../domain/ai-usage.js';

/*
 * Portão do órgão (US-116 · POL-18 · RN-AI-16..22 · DEC-079) — a porta `AiTenantGate` que a US-115
 * deixou obrigatória:
 *
 *   pedido (AI-01, na transação do pedido): IA ligada → trava por tenant (`pg_advisory_xact_lock`,
 *     liberada no commit) → `usado + reservado ativo + estimativa ≤ limite` e pedidos contados do
 *     dia < limite. A inserção `QUEUED` com `reservedTokens` acontece sob a mesma trava.
 *   execução (job, antes do provedor): IA ligada, `AI_GENERATE` do solicitante sobre o processo,
 *     consumo REAL ainda abaixo do limite e o dia sem a própria geração. Recusa → o job cancela
 *     (`CANCELED_BY_POLICY`) sem chamar o provedor nem consumir.
 *   término (`settle`, na transação do resultado): sob a trava, as faixas de 80%/100% que o consumo
 *     cruzou viram `AiUsageThresholdReached` (uma vez por mês e faixa — `eventId` determinístico +
 *     `recordOnce`).
 */

const AI_KEYS = [
  'ai.enabled',
  'ai.termsAcceptedVersion',
  'ai.monthlyTokenLimit',
  'ai.userDailyRequestLimit',
] as const;

export interface AiTenantSettings extends AiLimits {
  readonly enabled: boolean;
  readonly termsAcceptedVersion: string | null;
}

/** Retrato do consumo no instante (AI-05/AI-06 e as decisões do portão). */
export interface AiUsageSnapshot {
  readonly settings: AiTenantSettings;
  readonly timeZone: string;
  readonly month: string;
  readonly rows: readonly AiUsageRow[];
  readonly usage: MonthlyUsage;
}

@Injectable()
export class AiTenantGateService implements AiTenantGate {
  private readonly logger = new Logger('AiTenantGate');

  constructor(
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly tenancy: TenancyFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly access: AccessFacade,
    private readonly processes: DocumentProcessContextRegistry,
  ) {}

  /** Chaves `ai.*` efetivas do tenant (gravadas ou padrão do registro), lidas no `tx`. */
  async settingsOf(tx: TenantTx): Promise<AiTenantSettings> {
    const values = await this.tenancy.settingValues(tx, AI_KEYS);
    const terms = values.get('ai.termsAcceptedVersion');
    return {
      enabled: values.get('ai.enabled') === true,
      termsAcceptedVersion: typeof terms === 'string' ? terms : null,
      monthlyTokenLimit: Number(values.get('ai.monthlyTokenLimit')),
      userDailyRequestLimit: Number(values.get('ai.userDailyRequestLimit')),
    };
  }

  /** Fuso IANA do tenant (mês e dia civis do consumo). */
  timeZone(tx: TenantTx): Promise<string> {
    return this.calendar.timezone(tx);
  }

  /** Consumo do mês civil (fuso do tenant) do instante `at`, ou do mês `YYYY-MM` informado. */
  async snapshot(tx: TenantTx, at: Date = this.clock(), month?: string): Promise<AiUsageSnapshot> {
    const settings = await this.settingsOf(tx);
    const timeZone = await this.calendar.timezone(tx);
    const target = month ?? usageMonthOf(at, timeZone);
    const window = monthQueryWindow(target);
    const rows = rowsOfMonth(
      await this.generations.usageRows(tx, window.from, window.to),
      target,
      timeZone,
    );
    return { settings, timeZone, month: target, rows, usage: monthlyUsage(rows) };
  }

  async check(tx: TenantTx, request: AiGateRequest): Promise<AiGateDecision> {
    const settings = await this.settingsOf(tx);
    if (!settings.enabled) return { allowed: false, code: 'AI_DISABLED' };
    if (request.stage === 'EXECUTION' && !(await this.canGenerateOn(tx, request.processId))) {
      return { allowed: false, code: 'PERMISSION_DENIED' };
    }
    if (request.stage === 'REQUEST') await this.generations.lockTenantUsage(tx);

    const at = request.createdAt ?? this.clock();
    const { rows, usage, timeZone } = await this.snapshot(tx, at);
    const day = usageDayOf(at, timeZone);
    const denial =
      request.stage === 'REQUEST'
        ? requestLimitDenial(
            usage,
            request.reservedTokens,
            userDailyCount(rows, request.userId, day, timeZone),
            settings,
          )
        : executionLimitDenial(
            usage,
            userDailyCount(rows, request.userId, day, timeZone, request.generationId ?? null),
            settings,
          );
    return denial === null ? { allowed: true } : { allowed: false, code: denial };
  }

  /**
   * RN-AI-20: no término (sucesso, falha ou resposta descartada com tokens), publica as faixas que
   * o consumo do mês da geração cruzou. Chamado na transação que gravou os tokens.
   */
  async settle(tx: TenantTx, generation: AiGeneration, addedTokens: number): Promise<void> {
    const tokens = addedTokens;
    if (tokens <= 0) return;
    await this.generations.lockTenantUsage(tx);
    const { settings, month, usage } = await this.snapshot(tx, generation.createdAt);
    const limit = settings.monthlyTokenLimit;
    const after = usage.usedTokens;
    const before = after - tokens;
    if (after > limit && before <= limit) {
      this.logger.warn({
        event: 'ai.limit_overshoot',
        generationId: generation.id,
        month,
        usedTokens: after,
        limitTokens: limit,
      });
    }
    const tenantId = requireRequestContext().tenantId ?? generation.tenantId;
    for (const threshold of crossedThresholds(before, after, limit)) {
      const recorded = await this.outbox.recordOnce(
        tx,
        AiUsageThresholdReached.of({
          aggregateId: tenantId,
          payload: { month, threshold, usedTokens: after, limitTokens: limit },
        }),
        naturalKeyId(
          `ai-usage-threshold:${tenantId}:${month}:${String(threshold)}`,
          monthStartUtc(month),
        ),
      );
      if (recorded === null) continue;
      this.logger.log(
        {
          event: 'ai.usage_threshold_reached',
          month,
          threshold,
          usedTokens: after,
          limitTokens: limit,
        },
        'ai.usage_threshold_reached',
      );
    }
  }

  /** `AI_GENERATE` do solicitante (ator do job — DEC-164) ainda cobre o processo. */
  private async canGenerateOn(tx: TenantTx, processId: string): Promise<boolean> {
    const process = await this.processes.load(tx, processId);
    if (process === null) return false;
    return this.access.canOnProcess('AI_GENERATE', process.access);
  }
}
