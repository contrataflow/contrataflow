import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { emailMetrics } from './email-telemetry.js';
import { EmailTemplateRegistry } from './email-templates.js';
import { NotificationEmailSource } from './notification-email-source.js';

const N10 = '0192f111-0000-7000-8000-000000000010';
const TENANT = '0192f111-0000-7000-8000-00000000000a';

interface Scripted {
  readonly row?: Record<string, unknown> | null;
  readonly tenantStatus?: string | null;
  readonly rowCount?: number;
}

/** `SqlClient` roteirizado: devolve a linha da notificação, o status do tenant e o `rowCount`. */
function client(script: Scripted) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const sql: SqlClient = {
    query: (text: string, params: readonly unknown[] = []) => {
      calls.push({ sql: text, params });
      if (text.includes('FROM notifications n')) {
        return Promise.resolve({ rows: (script.row ? [script.row] : []) as never[], rowCount: 1 });
      }
      if (text.includes('FROM tenants')) {
        const rows = script.tenantStatus ? [{ status: script.tenantStatus }] : [];
        return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
      }
      return Promise.resolve({ rows: [] as never[], rowCount: script.rowCount ?? 1 });
    },
  };
  return { sql, calls };
}

const pendingRow = {
  type: 'APPROVAL_REQUESTED',
  title: 'Aprovação pendente',
  body: 'Há uma aprovação aguardando a sua decisão.',
  link: '/processos/1',
  email_status: 'PENDING',
  email: ' diego@pmsj.gov.br ',
};

function source(emailEnabled = true) {
  return new NotificationEmailSource(new EmailTemplateRegistry('https://app.test'), {
    tenantEmailEnabled: () => Promise.resolve(emailEnabled),
  });
}

describe('NotificationEmailSource (US-112)', () => {
  it('pendente, tenant ativo e e-mail ligado → send com o endereço resolvido agora', async () => {
    const { sql, calls } = client({ row: pendingRow, tenantStatus: 'ACTIVE' });
    await expect(source().prepare(sql, N10, TENANT)).resolves.toMatchObject({
      kind: 'send',
      to: 'diego@pmsj.gov.br',
      type: 'APPROVAL_REQUESTED',
      content: { subject: '[ContrataFlow] Aprovação pendente' },
    });
    expect(calls[0]?.params).toEqual([N10]);
    expect(calls[1]?.params).toEqual([TENANT]);
  });

  it('decide missing, not-pending, skip e fail na ordem das regras', async () => {
    await expect(source().prepare(client({ row: null }).sql, N10, TENANT)).resolves.toEqual({
      kind: 'missing',
    });
    await expect(
      source().prepare(client({ row: { ...pendingRow, email_status: 'SENT' } }).sql, N10, TENANT),
    ).resolves.toEqual({ kind: 'not-pending', status: 'SENT' });
    await expect(
      source().prepare(client({ row: pendingRow, tenantStatus: 'SUSPENDED' }).sql, N10, TENANT),
    ).resolves.toEqual({ kind: 'skip', reason: 'TENANT_INACTIVE' });
    await expect(
      source().prepare(client({ row: pendingRow, tenantStatus: null }).sql, N10, TENANT),
    ).resolves.toEqual({ kind: 'skip', reason: 'TENANT_INACTIVE' });
    await expect(
      source(false).prepare(client({ row: pendingRow, tenantStatus: 'ACTIVE' }).sql, N10, TENANT),
    ).resolves.toEqual({ kind: 'skip', reason: 'EMAIL_DISABLED' });
    await expect(
      source().prepare(
        client({ row: { ...pendingRow, email: null }, tenantStatus: 'ACTIVE' }).sql,
        N10,
        TENANT,
      ),
    ).resolves.toEqual({ kind: 'fail', code: 'NO_RECIPIENT', error: 'destinatário sem e-mail' });
    await expect(
      source().prepare(
        client({ row: { ...pendingRow, type: 'TIPO_NOVO' }, tenantStatus: 'ACTIVE' }).sql,
        N10,
        TENANT,
      ),
    ).resolves.toEqual({ kind: 'fail', code: 'TEMPLATE_MISSING', error: 'template ausente' });
  });

  it('transições condicionais a PENDING devolvem se a linha mudou', async () => {
    const changed = client({ rowCount: 1 });
    const at = new Date('2026-10-15T12:00:00.000Z');
    await expect(source().markSent(changed.sql, N10, at)).resolves.toBe(true);
    expect(changed.calls[0]?.sql).toMatch(
      /SET email_status = 'SENT'[\s\S]*email_status = 'PENDING'/,
    );
    expect(changed.calls[0]?.params).toEqual([N10, at]);

    const failed = client({ rowCount: 1 });
    await expect(source().markFailed(failed.sql, N10, `erro ${'x'.repeat(600)}`)).resolves.toBe(
      true,
    );
    expect(String(failed.calls[0]?.params[1])).toHaveLength(500);

    const untouched = client({ rowCount: 0 });
    await expect(source().markSkipped(untouched.sql, N10)).resolves.toBe(false);
    expect(untouched.calls[0]?.sql).toMatch(/SET email_status = 'SKIPPED'/);
  });
});

describe('métricas do EmailSender', () => {
  it('cria os contadores uma vez (no-op sem provedor OTel)', () => {
    const metrics = emailMetrics();
    expect(emailMetrics()).toBe(metrics);
    expect(() => {
      metrics.sent.add(1, { kind: 'NOTIFICATION', provider: 'smtp' });
      metrics.failed.add(1, { kind: 'NOTIFICATION', reason: 'REJECTED' });
      metrics.skipped.add(1, { kind: 'NOTIFICATION', reason: 'EMAIL_DISABLED' });
    }).not.toThrow();
  });
});
