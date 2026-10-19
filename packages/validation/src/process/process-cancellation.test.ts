import { describe, expect, it } from 'vitest';

import { ProcessDraftDiscarded, ProcessStatusChanged } from './events.js';
import {
  PROCESS_CANCELLATION_MESSAGES,
  cancelProcessSchema,
  discardProcessDraftSchema,
} from './process-cancellation.js';
import { ApprovalCanceled } from '../approval/events.js';
import { DocumentWithdrawn } from '../document/events.js';

describe('cancelProcessSchema (US-009 · V-01 · RN-PROC-104)', () => {
  it('aceita a justificativa com 20 caracteres ou mais, sem espaços nas pontas', () => {
    expect(
      cancelProcessSchema.parse({
        cancellationReason: '  Demanda já atendida por contrato vigente  ',
      }),
    ).toEqual({ cancellationReason: 'Demanda já atendida por contrato vigente' });
  });

  it.each([
    [{}, PROCESS_CANCELLATION_MESSAGES.reasonTooShort],
    [{ cancellationReason: '   ' }, PROCESS_CANCELLATION_MESSAGES.reasonTooShort],
    [
      { cancellationReason: `   ${'x'.repeat(19)}   ` },
      PROCESS_CANCELLATION_MESSAGES.reasonTooShort,
    ],
    [{ cancellationReason: 'x'.repeat(5001) }, PROCESS_CANCELLATION_MESSAGES.reasonTooLong],
  ])('recusa %j', (body, message) => {
    const result = cancelProcessSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('é estrito: campo extra recusado', () => {
    expect(
      cancelProcessSchema.safeParse({ cancellationReason: 'x'.repeat(20), extra: 1 }).success,
    ).toBe(false);
  });
});

describe('discardProcessDraftSchema (US-009 · motivo opcional até 500)', () => {
  it('sem motivo, com motivo e acima do limite', () => {
    expect(discardProcessDraftSchema.parse({})).toEqual({});
    expect(discardProcessDraftSchema.parse({ reason: ' Aberto por engano ' })).toEqual({
      reason: 'Aberto por engano',
    });
    const result = discardProcessDraftSchema.safeParse({ reason: 'x'.repeat(501) });
    expect(result.error?.issues[0]?.message).toBe(
      PROCESS_CANCELLATION_MESSAGES.discardReasonTooLong,
    );
  });
});

describe('eventos da US-009', () => {
  it('cancelamento → process.status_changed.canceled', () => {
    const event = ProcessStatusChanged.resolve({
      fromStatus: 'AWAITING_APPROVAL',
      toStatus: 'CANCELED',
      cause: 'CANCEL',
      reasonProvided: true,
      reason: 'Demanda já atendida por contrato vigente',
    });
    expect(event.routingKey).toBe('process.status_changed.canceled');
  });

  it('descarte, aprovação cancelada e documento retirado', () => {
    expect(ProcessDraftDiscarded.resolve({ reasonProvided: false }).routingKey).toBe(
      'process.draft_discarded',
    );
    expect(
      ApprovalCanceled.resolve({
        approvalId: '0192f009-0000-7000-8000-000000000001',
        reason: 'PROCESS_CANCELED',
      }).routingKey,
    ).toBe('approval.canceled');
    expect(
      DocumentWithdrawn.resolve({
        documentId: '0192f009-0000-7000-8000-000000000002',
        documentTypeCode: 'ETP',
        approvalId: '0192f009-0000-7000-8000-000000000001',
        reason: 'Processo cancelado',
      }).routingKey,
    ).toBe('document.withdrawn.etp');
  });
});
