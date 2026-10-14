import { Logger } from '@nestjs/common';

import type { SessionAuditBase, SessionAuditPort } from '../application/ports.js';

/**
 * Trilha `auth.session_start`/`auth.tenant_switch` (categoria SECURITY — RN-IAM-17) como log
 * estruturado até a auditoria transacional existir (US-073 troca este adaptador pelo
 * `AuditService`, gravando na instituição ativa). Tem os campos do `AuditLog` (events.md §7).
 */
export class LogSessionAuditRecorder implements SessionAuditPort {
  private readonly logger = new Logger('Audit');

  sessionStarted(
    entry: SessionAuditBase & {
      readonly selection: string;
      readonly firstLogin: boolean;
      readonly amr: readonly string[];
    },
  ): Promise<void> {
    this.logger.log(
      {
        event: 'audit.recorded',
        action: 'auth.session_start',
        category: 'SECURITY',
        tenantId: entry.tenantId,
        actorUserId: entry.userId,
        actorMembershipId: entry.membershipId,
        sessionIdHash: entry.sessionIdHash,
        ip: entry.ip,
        userAgent: entry.userAgent,
        metadata: { selection: entry.selection, firstLogin: entry.firstLogin, amr: entry.amr },
      },
      'auth.session_start',
    );
    return Promise.resolve();
  }

  tenantSwitched(
    entry: SessionAuditBase & { readonly fromTenantId: string | null },
  ): Promise<void> {
    this.logger.log(
      {
        event: 'audit.recorded',
        action: 'auth.tenant_switch',
        category: 'SECURITY',
        tenantId: entry.tenantId,
        actorUserId: entry.userId,
        actorMembershipId: entry.membershipId,
        sessionIdHash: entry.sessionIdHash,
        ip: entry.ip,
        userAgent: entry.userAgent,
        metadata: { fromTenantId: entry.fromTenantId, toTenantId: entry.tenantId },
      },
      'auth.tenant_switch',
    );
    return Promise.resolve();
  }
}
