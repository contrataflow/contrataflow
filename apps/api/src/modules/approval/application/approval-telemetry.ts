import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

/*
 * Métricas da solicitação de aprovação (DoD da US-051 — orçamento de p95 < 150 ms da lógica
 * embutida no PRC-19/DOC-09) e da decisão (US-052 — p95 < 1,5 s sem encadeamento). Convenção do
 * repositório: `cf_<módulo>_<fato>`.
 */

interface Instruments {
  readonly requested: Counter;
  readonly duration: Histogram;
  readonly failed: Counter;
  readonly decided: Counter;
  readonly decideDuration: Histogram;
  readonly decideFailed: Counter;
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
    decided: meter.createCounter('cf_approval_decided_total', {
      description: 'Aprovações decididas, por decisão, assunto, substituto e encadeamento.',
    }),
    decideDuration: meter.createHistogram('cf_approval_decide_duration_ms', {
      description: 'Duração da decisão de aprovação (APV-03), com e sem encadeamento.',
      unit: 'ms',
    }),
    decideFailed: meter.createCounter('cf_approval_decide_failed_total', {
      description: 'Decisões de aprovação que falharam por indisponibilidade ou erro inesperado.',
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

export function recordApprovalDecided(
  decision: string,
  subjectType: string,
  attributes: { readonly asDeputy: boolean; readonly chained: boolean },
  durationMs: number,
): void {
  const { decided, decideDuration } = approvalMetrics();
  const labels = {
    decision,
    subject_type: subjectType,
    as_deputy: String(attributes.asDeputy),
    chained: String(attributes.chained),
  };
  decided.add(1, labels);
  decideDuration.record(durationMs, { decision, chained: String(attributes.chained) });
}

export function recordApprovalDecideFailed(errorCode: string): void {
  approvalMetrics().decideFailed.add(1, { error_code: errorCode });
}
