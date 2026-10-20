import { describe, expect, it } from 'vitest';

import { ProcessStatusChanged } from './events.js';
import {
  PROCESS_SUSPENSION_MESSAGES,
  resumeProcessSchema,
  suspendProcessSchema,
} from './process-suspension.js';

describe('suspendProcessSchema (US-008 · V-01)', () => {
  it('aceita o motivo de 20 a 5.000 caracteres, sem espaços nas pontas', () => {
    expect(suspendProcessSchema.parse({ reason: '  Aguardando definição da dotação  ' })).toEqual({
      reason: 'Aguardando definição da dotação',
    });
  });

  it.each([
    [{}, PROCESS_SUSPENSION_MESSAGES.reasonRequired],
    [{ reason: '   ' }, PROCESS_SUSPENSION_MESSAGES.reasonRequired],
    [{ reason: 'Pausa' }, PROCESS_SUSPENSION_MESSAGES.reasonRequired],
    [{ reason: 'x'.repeat(5001) }, PROCESS_SUSPENSION_MESSAGES.reasonTooLong],
  ])('recusa %j', (body, message) => {
    const result = suspendProcessSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('é estrito: campo extra recusado', () => {
    expect(suspendProcessSchema.safeParse({ reason: 'x'.repeat(20), extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('resumeProcessSchema (RN-PROC-97)', () => {
  it('comentário opcional, até 5.000', () => {
    expect(resumeProcessSchema.parse({})).toEqual({});
    expect(resumeProcessSchema.parse({ comment: ' Dotação definida ' })).toEqual({
      comment: 'Dotação definida',
    });
    expect(resumeProcessSchema.safeParse({ comment: 'x'.repeat(5001) }).success).toBe(false);
  });
});

describe('ProcessStatusChanged — routing keys da suspensão (RN-PROC-101)', () => {
  const of = (payload: Parameters<typeof ProcessStatusChanged.resolve>[0]) =>
    ProcessStatusChanged.resolve(payload);

  it('suspensão → process.status_changed.suspended, com o motivo', () => {
    const event = of({
      fromStatus: 'IN_PROGRESS',
      toStatus: 'SUSPENDED',
      cause: 'SUSPEND',
      reasonProvided: true,
      reason: 'Aguardando definição da dotação',
    });
    expect(event.routingKey).toBe('process.status_changed.suspended');
  });

  it('retomada → process.status_changed.resumed, qualquer que seja o status restaurado', () => {
    const event = of({
      fromStatus: 'SUSPENDED',
      toStatus: 'AWAITING_APPROVAL',
      cause: 'RESUME',
      reasonProvided: false,
    });
    expect(event.routingKey).toBe('process.status_changed.resumed');
  });

  it('as demais causas seguem o status de destino', () => {
    const event = of({
      fromStatus: 'IN_PROGRESS',
      toStatus: 'AWAITING_APPROVAL',
      cause: 'FORWARD',
      reasonProvided: false,
    });
    expect(event.routingKey).toBe('process.status_changed.awaiting_approval');
  });
});
