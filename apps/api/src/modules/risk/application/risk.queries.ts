import type {
  RiskDto,
  RiskListMetaDto,
  RiskListQuery,
  RiskMatrixDto,
  RiskMatrixQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';

import { RISK_REPOSITORY, RISK_TRANSACTIONS } from './ports.js';
import type { RiskRepository, RiskTransactions } from './ports.js';
import { RiskGate, RiskPresenter, RiskScaleReader } from './risk.support.js';
import { riskMatrixOf } from '../domain/risk-map.js';

/*
 * Consultas de riscos (US-033 · RSK-01/RSK-03): `PROCESS_VIEW` pela visibilidade do processo
 * (DEC-024 — não visível = 404). A lista traz em `meta` a escala vigente (rótulos da grade), o
 * documento `RISK_MAP` e se o usuário pode gerenciar agora (botões do SCR-011 — FA-04).
 */

export interface RiskList {
  readonly risks: RiskDto[];
  readonly meta: RiskListMetaDto;
}

@Injectable()
export class ListRisksQuery {
  constructor(
    @Inject(RISK_TRANSACTIONS) private readonly transactions: RiskTransactions,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly scales: RiskScaleReader,
    private readonly presenter: RiskPresenter,
  ) {}

  execute(processId: string, filter: RiskListQuery): Promise<RiskList> {
    return this.transactions.read(async (tx) => {
      const state = await this.gate.readable(tx, processId);
      const snapshot = await this.scales.current(tx);
      const risks = await this.risks.listByProcess(tx, processId, filter);
      return {
        risks: await this.presenter.present(tx, risks),
        meta: {
          scale: snapshot.scale,
          levelThresholds: [...snapshot.levelThresholds],
          riskMap: state.owner,
          canManage: state.lockReason === null,
          lockReason: state.lockReason,
        },
      };
    });
  }
}

@Injectable()
export class GetRiskQuery {
  constructor(
    @Inject(RISK_TRANSACTIONS) private readonly transactions: RiskTransactions,
    private readonly gate: RiskGate,
    private readonly presenter: RiskPresenter,
  ) {}

  execute(riskId: string): Promise<RiskDto> {
    return this.transactions.read(async (tx) => {
      const { risk } = await this.gate.readableRisk(tx, riskId);
      const [dto] = await this.presenter.present(tx, [risk]);
      if (!dto) throw new Error('Risco sem DTO.');
      return dto;
    });
  }
}

/** `risk_map.matrix_viewed` é amostrado (story · "Logs"): 1 em cada 10 leituras. */
const MATRIX_LOG_SAMPLE_RATE = 0.1;

/**
 * RSK-09 — matriz de riscos (US-035 · RN-RISK-18/24): `PROCESS_VIEW` pela visibilidade do processo
 * (não visível ou de outro tenant = 404), os riscos não excluídos com os filtros de RSK-01 e a
 * escala/faixas VIGENTES. Lê sempre os riscos atuais, qualquer que seja o status do `RISK_MAP`.
 */
@Injectable()
export class GetRiskMatrixQuery {
  private readonly logger = new Logger('RiskMap');

  constructor(
    @Inject(RISK_TRANSACTIONS) private readonly transactions: RiskTransactions,
    @Inject(RISK_REPOSITORY) private readonly risks: RiskRepository,
    private readonly gate: RiskGate,
    private readonly scales: RiskScaleReader,
  ) {}

  async execute(processId: string, filter: RiskMatrixQuery): Promise<RiskMatrixDto> {
    const { matrix, riskCount } = await this.transactions.read(async (tx) => {
      await this.gate.readable(tx, processId);
      const current = await this.scales.current(tx);
      const risks = await this.risks.listByProcess(tx, processId, filter);
      return { matrix: riskMatrixOf(risks, current), riskCount: risks.length };
    });
    if (Math.random() < MATRIX_LOG_SAMPLE_RATE) {
      this.logger.log(
        {
          event: 'risk_map.matrix_viewed',
          processId,
          riskCount,
          correlationId: requireRequestContext().correlationId,
        },
        'risk_map.matrix_viewed',
      );
    }
    return matrix;
  }
}
