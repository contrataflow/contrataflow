import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da solicitação de aprovação (DoD da US-051 — orçamento de p95 < 150 ms da lógica
 * embutida no PRC-19/DOC-09). Convenção do repositório: `cf_<módulo>_<fato>`.
 */

interface Instruments {
  readonly requested: Counter;
  readonly duration: Histogram;
  readonly failed: Counter;
}

let instruments: Instruments | undefined;

function approvalMetrics(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    requested: meter.createCounter('cf_approval_requested_total', {
      description: 'Aprovações solicitadas (Approval PENDING), por assunto e tipo de aprovador.',
    }),
    duration: meter.createHistogram('cf_approval_request_duration_ms', {
      description: 'Duração da lógica de solicitação de aprovação dentro da transação de origem.',
      unit: 'ms',
    }),
    failed: meter.createCounter('cf_approval_request_failed_total', {
      description: 'Solicitações de aprovação recusadas, por assunto e código de erro.',
    }),
  };
  return instruments;
}

export function recordApprovalRequested(
  subjectType: string,
  approverType: string,
  durationMs: number,
): void {
  const { requested, duration } = approvalMetrics();
  requested.add(1, { subject_type: subjectType, approver_type: approverType });
  duration.record(durationMs, { subject_type: subjectType, approver_type: approverType });
}

export function recordApprovalRequestFailed(subjectType: string, errorCode: string): void {
  approvalMetrics().failed.add(1, { subject_type: subjectType, error_code: errorCode });
}
