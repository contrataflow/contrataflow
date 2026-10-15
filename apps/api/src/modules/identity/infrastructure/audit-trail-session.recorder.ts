import { sessionEndAuditAction, isSessionExpiryReason } from '@contrataflow/types';
import type { SessionTombstone } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import {
  runAsSystem,
  runWithClientDetails,
  runWithTenantScope,
} from '#shared/context/request-context.js';

import type { SessionAuditBase, SessionAuditPort } from '../application/ports.js';

/** Nome do contexto de sistema da varredura (o ator gravado é o dono da sessão). */
export const SESSION_SWEEP_JOB_NAME = 'Varredura de sessões';

/**
 * Trilha `auth.*` (RN-IAM-17/28 · authentication.md §3) gravada pelo `AuditService` na instituição
 * ativa da sessão (US-073).
 *
 * Início e troca de instituição: a chamada vem do servidor do BFF; o IP, o user-agent e o hash da
 * sessão do navegador chegam no corpo e passam a valer no contexto.
 *
 * Encerramento (US-088): a chamada vem da varredura, sem requisição. O contexto é aberto como job
 * (`runAsSystem`) e entra no escopo do dono da sessão — o ator é a própria pessoa (`USER`), com o
 * IP e o user-agent guardados no registro de encerramento. O horário do registro é o do fato
 * (`occurredAt`), e `oncePerSession` impede a segunda gravação quando a varredura refaz o registro
 * depois de uma falha.
 */
@Injectable()
export class AuditTrailSessionRecorder implements SessionAuditPort {
  private readonly logger = new Logger('SessionAudit');

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

  async sessionEnded(tombstone: SessionTombstone): Promise<'recorded' | 'duplicate'> {
    const { activeTenantId: tenantId, membershipId } = tombstone;
    if (tenantId === null) return 'duplicate';
    if (membershipId === null) {
      // Sessão com instituição e sem vínculo não existe pelo contrato do BFF; sem o vínculo não há
      // ator íntegro para a trilha. Não trava a fila de encerramentos (o chamador apaga o registro).
      this.logger.warn(
        { event: 'auth.session_audit_skipped', reason: 'MEMBERSHIP_MISSING', tenantId },
        'auth.session_audit_skipped',
      );
      return 'duplicate';
    }

    const outcome = await runAsSystem({ name: SESSION_SWEEP_JOB_NAME, tenantId }, () =>
      runWithTenantScope(
        { tenantId, userId: tombstone.userId, membershipId, actorName: tombstone.displayName },
        () =>
          runWithClientDetails(
            { ip: tombstone.ip, userAgent: tombstone.userAgent, sessionIdHash: tombstone.key },
            () =>
              this.audit.recordStandalone({
                action: sessionEndAuditAction(tombstone.reason),
                occurredAt: new Date(tombstone.occurredAt),
                oncePerSession: true,
                metadata: endMetadata(tombstone),
              }),
          ),
      ),
    );
    return outcome.kind === 'duplicate' ? 'duplicate' : 'recorded';
  }
}

/** Expiração: o limite de ociosidade vigente; demais motivos: a duração da sessão em minutos. */
function endMetadata(tombstone: SessionTombstone): Record<string, unknown> {
  if (isSessionExpiryReason(tombstone.reason)) {
    return { reason: tombstone.reason, idleMinutes: tombstone.idleMinutes };
  }
  return {
    reason: tombstone.reason,
    sessionAgeMinutes: Math.max(
      0,
      Math.round((tombstone.occurredAt - tombstone.createdAt) / 60_000),
    ),
  };
}
