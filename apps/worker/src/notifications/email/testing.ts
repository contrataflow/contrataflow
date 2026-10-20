import type { SqlClient } from '#shared/database/outbox-database.js';
import type { AdvisoryLockResult } from '#shared/database/worker-database.js';

import type { EmailSendLock } from './email-sender.js';
import { isDeliverableAddress, truncateEmailError } from './email-source.js';
import type { EmailPreparation, EmailSource } from './email-source.js';
import type { EmailTemplateRegistry } from './email-templates.js';

/* Dublês do `EmailSender` para testes unitários (sem PostgreSQL). */

export interface MemoryEmailRow {
  type: string;
  title: string;
  body: string;
  link: string | null;
  email: string | null;
  status: string;
  error: string | null;
  sentAt: Date | null;
}

/** Mesmo contrato do `NotificationEmailSource` (transições condicionais a `PENDING`), em memória. */
export class MemoryEmailSource implements EmailSource {
  readonly rows = new Map<string, MemoryEmailRow>();
  tenantStatus = 'ACTIVE';
  emailEnabled = true;
  /** Erro lançado pela próxima gravação de `SENT` (banco indisponível). */
  failMarkSent: Error | null = null;

  constructor(private readonly templates: EmailTemplateRegistry) {}

  add(id: string, row: Partial<MemoryEmailRow> = {}): MemoryEmailRow {
    const full: MemoryEmailRow = {
      type: 'APPROVAL_REQUESTED',
      title: 'Aprovação pendente',
      body: 'Há uma aprovação aguardando a sua decisão.',
      link: '/processos/0192f111-0000-7000-8000-0000000000c1',
      email: 'diego@pmsj.gov.br',
      status: 'PENDING',
      error: null,
      sentAt: null,
      ...row,
    };
    this.rows.set(id, full);
    return full;
  }

  prepare(_client: SqlClient, id: string): Promise<EmailPreparation> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve({ kind: 'missing' });
    if (row.status !== 'PENDING')
      return Promise.resolve({ kind: 'not-pending', status: row.status });
    if (this.tenantStatus !== 'ACTIVE')
      return Promise.resolve({ kind: 'skip', reason: 'TENANT_INACTIVE' });
    if (!this.emailEnabled) return Promise.resolve({ kind: 'skip', reason: 'EMAIL_DISABLED' });
    if (!isDeliverableAddress(row.email)) {
      return Promise.resolve({
        kind: 'fail',
        code: 'NO_RECIPIENT',
        error: 'destinatário sem e-mail',
      });
    }
    const content = this.templates.render(row);
    if (!content)
      return Promise.resolve({ kind: 'fail', code: 'TEMPLATE_MISSING', error: 'template ausente' });
    return Promise.resolve({ kind: 'send', to: row.email, content, type: row.type });
  }

  markSent(_client: SqlClient, id: string, sentAt: Date): Promise<boolean> {
    if (this.failMarkSent) {
      const error = this.failMarkSent;
      this.failMarkSent = null;
      return Promise.reject(error);
    }
    return Promise.resolve(
      this.transition(id, (row) => Object.assign(row, { status: 'SENT', sentAt, error: null })),
    );
  }

  markFailed(_client: SqlClient, id: string, error: string): Promise<boolean> {
    return Promise.resolve(
      this.transition(id, (row) =>
        Object.assign(row, { status: 'FAILED', error: truncateEmailError(error) }),
      ),
    );
  }

  markSkipped(_client: SqlClient, id: string): Promise<boolean> {
    return Promise.resolve(this.transition(id, (row) => Object.assign(row, { status: 'SKIPPED' })));
  }

  private transition(id: string, apply: (row: MemoryEmailRow) => void): boolean {
    const row = this.rows.get(id);
    if (row?.status !== 'PENDING') return false;
    apply(row);
    return true;
  }
}

/** Trava consultiva em memória (como `pg_try_advisory_lock`: quem não pega, não espera). */
export class MemoryEmailSendLock implements EmailSendLock {
  private readonly held = new Set<string>();

  async withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
    if (this.held.has(key)) return { acquired: false };
    this.held.add(key);
    try {
      return { acquired: true, result: await work() };
    } finally {
      this.held.delete(key);
    }
  }
}
