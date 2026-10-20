import { describe, expect, it } from 'vitest';

import { buildMailMessage, messageIdFor, senderDomain } from './mail-message.js';

const ID = '0192f111-0000-7000-8000-0000000000aa';
const content = { subject: 'Assunto', html: '<p>x</p>', text: 'x' };

describe('MailMessage (US-112 · RN-NTF-18)', () => {
  it('cabeçalhos técnicos obrigatórios e Message-ID derivado do notificationId', () => {
    const message = buildMailMessage({
      kind: 'NOTIFICATION',
      sourceId: ID,
      from: 'ContrataFlow <nao-responda@ContrataFlow.gov.br>',
      to: 'diego@pmsj.gov.br',
      correlationId: 'corr-1\r\nX-Injetado: sim',
      content,
    });
    expect(message).toMatchObject({
      to: 'diego@pmsj.gov.br',
      subject: 'Assunto',
      messageId: `<notification.${ID}@contrataflow.gov.br>`,
      headers: {
        'X-Correlation-Id': 'corr-1 X-Injetado: sim',
        'X-CF-Notification-Id': ID,
        'Auto-Submitted': 'auto-generated',
      },
    });
  });

  it('convite usa X-CF-Membership-Id e Message-ID próprio', () => {
    const message = buildMailMessage({
      kind: 'INVITATION',
      sourceId: ID,
      from: 'nao-responda@cf.test',
      to: 'a@b.test',
      correlationId: 'c',
      content,
    });
    expect(message.messageId).toBe(`<invitation.${ID}@cf.test>`);
    expect(message.headers).toEqual({
      'X-Correlation-Id': 'c',
      'X-CF-Membership-Id': ID,
      'Auto-Submitted': 'auto-generated',
    });
  });

  it('Message-ID estável e domínio de reserva quando o remetente não tem domínio', () => {
    expect(messageIdFor('NOTIFICATION', ID, 'a@x.test')).toBe(
      messageIdFor('NOTIFICATION', ID, 'a@x.test'),
    );
    expect(senderDomain('sem-arroba')).toBe('contrataflow.invalid');
    expect(senderDomain('Nome <a@>')).toBe('contrataflow.invalid');
  });
});
