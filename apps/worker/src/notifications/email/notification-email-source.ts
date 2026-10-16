import type { SqlClient } from '#shared/database/outbox-database.js';

import { isDeliverableAddress, truncateEmailError } from './email-source.js';
import type { EmailPreparation, EmailSource } from './email-source.js';
import type { EmailTemplateRegistry } from './email-templates.js';
import type { NotificationDirectory } from '../recipient-resolver.js';

interface NotificationEmailRow {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly email_status: string;
  readonly email: string | null;
}

/**
 * E-mail de uma `Notification` (US-111 → US-112), na `tenantTransaction` do job com o papel
 * `cf_worker` (RLS: notificação de outro tenant não é lida nem atualizada). O endereço vem de
 * `users` só aqui (RN-NTF-14); `tenants` (plataforma, sem RLS) e `notifications.emailEnabled`
 * (`tenant_settings`) são revalidados porque podem ter mudado depois que a notificação ficou
 * `PENDING` (FA-01/FA-04).
 */
export class NotificationEmailSource implements EmailSource {
  constructor(
    private readonly templates: EmailTemplateRegistry,
    private readonly directory: Pick<NotificationDirectory, 'tenantEmailEnabled'>,
  ) {}

  async prepare(
    client: SqlClient,
    notificationId: string,
    tenantId: string,
  ): Promise<EmailPreparation> {
    const { rows } = await client.query<NotificationEmailRow>(
      `SELECT n.type, n.title, n.body, n.link, n.email_status::text AS email_status,
              u.email::text AS email
         FROM notifications n
         LEFT JOIN users u ON u.id = n.recipient_id
        WHERE n.id = $1`,
      [notificationId],
    );
    const row = rows[0];
    if (!row) return { kind: 'missing' };
    if (row.email_status !== 'PENDING') return { kind: 'not-pending', status: row.email_status };

    const tenant = await client.query<{ status: string }>(
      'SELECT status::text AS status FROM tenants WHERE id = $1',
      [tenantId],
    );
    if (tenant.rows[0]?.status !== 'ACTIVE') return { kind: 'skip', reason: 'TENANT_INACTIVE' };
    if (!(await this.directory.tenantEmailEnabled(client))) {
      return { kind: 'skip', reason: 'EMAIL_DISABLED' };
    }
    if (!isDeliverableAddress(row.email)) {
      return { kind: 'fail', code: 'NO_RECIPIENT', error: 'destinatário sem e-mail' };
    }
    const content = this.templates.render(row);
    if (!content) return { kind: 'fail', code: 'TEMPLATE_MISSING', error: 'template ausente' };
    return { kind: 'send', to: row.email.trim(), content, type: row.type };
  }

  markSent(client: SqlClient, notificationId: string, sentAt: Date): Promise<boolean> {
    return this.transition(
      client,
      `UPDATE notifications
          SET email_status = 'SENT', email_sent_at = $2, email_error = NULL
        WHERE id = $1 AND email_status = 'PENDING'`,
      [notificationId, sentAt],
    );
  }

  markFailed(client: SqlClient, notificationId: string, error: string): Promise<boolean> {
    return this.transition(
      client,
      `UPDATE notifications
          SET email_status = 'FAILED', email_error = $2
        WHERE id = $1 AND email_status = 'PENDING'`,
      [notificationId, truncateEmailError(error)],
    );
  }

  markSkipped(client: SqlClient, notificationId: string): Promise<boolean> {
    return this.transition(
      client,
      `UPDATE notifications SET email_status = 'SKIPPED'
        WHERE id = $1 AND email_status = 'PENDING'`,
      [notificationId],
    );
  }

  private async transition(
    client: SqlClient,
    sql: string,
    params: readonly unknown[],
  ): Promise<boolean> {
    const result = await client.query(sql, params);
    return (result.rowCount ?? 0) > 0;
  }
}
