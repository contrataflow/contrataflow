import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runWithClientDetails } from '#shared/context/request-context.js';

import type { SessionAuditBase, SessionAuditPort } from '../application/ports.js';

/**
 * Trilha `auth.session_start`/`auth.tenant_switch` (RN-IAM-17 · authentication.md §3) gravada pelo
 * `AuditService` na instituição ativa (US-073). A chamada vem do servidor do BFF: o IP, o
 * user-agent e o hash da sessão do navegador chegam no corpo e passam a valer no contexto.
 */
@Injectable()
export class AuditTrailSessionRecorder implements SessionAuditPort {
  constructor(@Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort) {}

  async sessionStarted(
    entry: SessionAuditBase & {
      readonly selection: string;
      readonly firstLogin: boolean;
      readonly amr: readonly string[];
    },
  ): Promise<void> {
    await runWithClientDetails(entry, () =>
      this.audit.recordStandalone({
        action: 'auth.session_start',
        metadata: { selection: entry.selection, firstLogin: entry.firstLogin, amr: entry.amr },
      }),
    );
  }

  async tenantSwitched(
    entry: SessionAuditBase & { readonly fromTenantId: string | null },
  ): Promise<void> {
    await runWithClientDetails(entry, () =>
      this.audit.recordStandalone({
        action: 'auth.tenant_switch',
        metadata: { fromTenantId: entry.fromTenantId, toTenantId: entry.tenantId },
      }),
    );
  }
}
