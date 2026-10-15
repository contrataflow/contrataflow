import { withSpan } from '@contrataflow/observability';
import type { NumberingPreviewResult, NumberingScope } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { CATALOG_CLOCK } from './catalog-ports.js';
import type { CatalogClock } from './catalog-ports.js';
import { NUMBER_SEQUENCE_REPOSITORY, NUMBERING_SETTINGS_READER } from './numbering-ports.js';
import type {
  NumberingSettings,
  NumberingSettingsReader,
  NumberSequenceRepository,
} from './numbering-ports.js';
import {
  documentSequenceKey,
  effectiveProcessScope,
  formatNumberMask,
  NumberMask,
  numberingYear,
  processSequenceKey,
  resolveDocumentMask,
} from '../domain/number-mask.js';
import type { NumberMaskTokens } from '../domain/number-mask.js';

/** Espera acima disto no bloqueio da sequência gera `warn` `numbering.lock_wait` (story · Logs). */
export const NUMBERING_LOCK_WAIT_WARN_MS = 200;

/** Número atribuído a um processo ou documento. */
export interface AssignedNumber {
  readonly sequenceKey: string;
  /** Valor da sequência (`Process.number`/`Document.number`). */
  readonly number: number;
  /** Exercício (`year`). */
  readonly year: number;
  /** Número formatado pela máscara (`code`, ex.: `0012/2026`). */
  readonly code: string;
}

export interface AssignDocumentNumberInput {
  readonly documentTypeCode: string;
  /** `DocumentType.numberingMask` (`null` = sem máscara própria — RN-TEN-72). */
  readonly typeMask: string | null;
  /** Órgão do processo (sigla em `{org}`, quando a máscara usa). */
  readonly organizationId: string;
}

export interface PreviewNumberingInput {
  readonly mask: string;
  readonly scope?: NumberingScope | undefined;
  /** Presente: máscara de documento daquele tipo; ausente: máscara do processo. */
  readonly documentTypeCode?: string | undefined;
}

let assignDuration: Histogram | undefined;

/** `cf_numbering_assign_duration_ms{target}` — latência da obtenção do número (DoD da US-105). */
function recordAssignDuration(durationMs: number, target: string): void {
  assignDuration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('cf_numbering_assign_duration_ms', {
      description:
        'Duração do incremento da sequência de numeração (inclui a espera pelo bloqueio).',
      unit: 'ms',
    });
  assignDuration.record(durationMs, { target });
}

/**
 * API pública de numeração do módulo `catalog` (DEC-041 · DEC-028 · US-105): o ÚNICO ponto de
 * geração de número para processos (US-001/US-047) e documentos (US-014, US-063…). Todo método de
 * atribuição roda na transação do recurso numerado (`tx`), do tenant do contexto: o incremento
 * bloqueia a linha da sequência até o commit e é desfeito com o rollback (RN-TEN-69). Quem chama
 * mantém a transação curta. `assignOn` (`CREATE`/`START` — RN-TEN-71) é decidido por quem cria ou
 * autua o processo; a fachada só numera.
 */
@Injectable()
export class NumberingFacade {
  private readonly logger = new Logger('Numbering');

  constructor(
    @Inject(NUMBER_SEQUENCE_REPOSITORY) private readonly sequences: NumberSequenceRepository,
    @Inject(NUMBERING_SETTINGS_READER) private readonly settings: NumberingSettingsReader,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
  ) {}

  /** Configuração `numbering.*` efetiva e fuso do tenant do contexto. */
  settingsOf(tx: TenantTx): Promise<NumberingSettings> {
    return this.settings.read(tx, requireRequestContext().tenantId ?? '');
  }

  /**
   * RN-TEN-69: próximo valor da sequência (criada sob demanda), NA transação do chamador. Registra
   * `numbering.assigned`, a latência e, acima de 200 ms, `numbering.lock_wait`.
   */
  async next(tx: TenantTx, sequenceKey: string): Promise<number> {
    const target = sequenceKey.split(':')[0] ?? 'UNKNOWN';
    return withSpan('numbering.next', { 'cf.numbering.target': target }, async () => {
      const startedAt = performance.now();
      const value = await this.sequences.increment(tx, sequenceKey);
      const durationMs = Math.round(performance.now() - startedAt);
      recordAssignDuration(durationMs, target);
      const tenantId = requireRequestContext().tenantId;
      if (durationMs > NUMBERING_LOCK_WAIT_WARN_MS) {
        this.logger.warn(
          { event: 'numbering.lock_wait', sequenceKey, durationMs, tenantId },
          'numbering.lock_wait',
        );
      }
      this.logger.log(
        { event: 'numbering.assigned', sequenceKey, value, durationMs, tenantId },
        'numbering.assigned',
      );
      return value;
    });
  }

  /**
   * Número do processo (RN-PROC-04/05 · RN-TEN-68/70): sequência do exercício no fuso do tenant,
   * no escopo do ano (o configurado só vale a partir do próximo exercício) e máscara
   * `numbering.process.mask`.
   */
  async assignProcessNumber(
    tx: TenantTx,
    input: { readonly organizationId: string },
  ): Promise<AssignedNumber> {
    const settings = await this.settingsOf(tx);
    const year = numberingYear(this.clock(), settings.timezone);
    const scope = effectiveProcessScope(
      settings.processScope,
      await this.sequences.openedProcessKeyOfYear(tx, year),
    );
    const sequenceKey = processSequenceKey(scope, input.organizationId, year);
    const number = await this.next(tx, sequenceKey);
    const code = formatNumberMask(settings.processMask, {
      sequence: number,
      year,
      organization: await this.organizationFor(tx, settings.processMask, input.organizationId),
    });
    return { sequenceKey, number, year, code };
  }

  /**
   * Número do documento (RN-DOC-24 · RN-TEN-72): sequência por tipo e exercício no tenant e a
   * máscara própria do tipo, o override `numbering.document.<TYPE>.mask` ou a padrão.
   */
  async assignDocumentNumber(
    tx: TenantTx,
    input: AssignDocumentNumberInput,
  ): Promise<AssignedNumber> {
    const settings = await this.settingsOf(tx);
    const year = numberingYear(this.clock(), settings.timezone);
    const { mask } = resolveDocumentMask({
      typeMask: input.typeMask,
      settingMask: settings.documentMasks.get(input.documentTypeCode) ?? null,
      defaultMask: settings.documentDefaultMask,
    });
    const sequenceKey = documentSequenceKey(input.documentTypeCode, year);
    const number = await this.next(tx, sequenceKey);
    const code = formatNumberMask(mask, {
      sequence: number,
      year,
      type: input.documentTypeCode,
      organization: await this.organizationFor(tx, mask, input.organizationId),
    });
    return { sequenceKey, number, year, code };
  }

  /**
   * SET-04 · RN-TEN-73 · FA-04: exemplo da máscara INFORMADA (nunca a gravada) com o próximo valor
   * hipotético (`lastValue + 1`) da sequência corrente — leitura simples, sem gravar, incrementar
   * nem disputar o bloqueio da sequência real. `{org}` usa a sigla do órgão principal.
   * @throws InvalidNumberMaskError
   */
  async preview(tx: TenantTx, input: PreviewNumberingInput): Promise<NumberingPreviewResult> {
    const settings = await this.settingsOf(tx);
    const tenantId = requireRequestContext().tenantId ?? '';
    const isDocument = input.documentTypeCode !== undefined;
    const scope = input.scope ?? settings.processScope;
    const mask = NumberMask.parse(input.mask, isDocument ? 'DOCUMENT' : 'PROCESS', scope);
    const year = numberingYear(this.clock(), settings.timezone);
    const organization = await this.settings.primaryOrganization(tx, tenantId);
    const sequenceKey =
      input.documentTypeCode === undefined
        ? processSequenceKey(scope, organization?.id ?? '', year)
        : documentSequenceKey(input.documentTypeCode, year);
    const nextValue = (await this.sequences.lastValue(tx, sequenceKey)) + 1;
    return {
      example: mask.format({
        sequence: nextValue,
        year,
        organization: organization?.shortName ?? null,
        type: input.documentTypeCode ?? null,
      }),
      nextValue: String(nextValue),
    };
  }

  /** Aplica a máscara aos valores (`"{seq:4}/{year}"` → `"0012/2026"`). */
  formatMask(mask: string, tokens: NumberMaskTokens): string {
    return formatNumberMask(mask, tokens);
  }

  /** Sigla do órgão só quando a máscara usa `{org}` (evita a leitura nos demais casos). */
  private async organizationFor(
    tx: TenantTx,
    mask: string,
    organizationId: string,
  ): Promise<string | null> {
    if (!mask.includes('{org}')) return null;
    return (await this.settings.organization(tx, organizationId))?.shortName ?? null;
  }
}
