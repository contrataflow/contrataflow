import { localDateOf } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientSpec } from './recipient-spec.js';

/*
 * Lembretes de prazo e alertas de atraso (US-114 · events.md §6 · RN-NTF-27..32). O job
 * `deadlines` (US-055) decide QUANDO avisar e emite `ProcessStageDueSoon`/`ProcessStageOverdue`
 * uma única vez por passagem; aqui se decide só QUEM recebe e COMO o aviso aparece.
 */

export type StageDeadlineType = 'STAGE_DUE_SOON' | 'STAGE_OVERDUE';

export interface StageDeadlineParties {
  /** Responsável da passagem (`assigneeId` do evento); nulo = fila da unidade. */
  readonly assigneeId: string | null;
  /** Unidade da passagem — o titular (`Department.headUserId`) é resolvido no diretório. */
  readonly departmentId: string | null;
}

/**
 * `StageDeadlineRecipientResolver` (RN-NTF-27): `STAGE_DUE_SOON` vai ao responsável ou, na
 * ausência, ao titular da unidade; `STAGE_OVERDUE` vai a AMBOS, como destinatários independentes
 * (escalonamento). O substituto nunca entra. O `RecipientResolver` une as especificações num
 * conjunto — responsável = titular gera uma notificação só (RN-NTF-28) — e, sem nenhum dos dois,
 * não resolve ninguém (RN-NTF-29: nenhum fallback além deste).
 */
export function stageDeadlineRecipients(
  type: StageDeadlineType,
  parties: StageDeadlineParties,
): readonly RecipientSpec[] {
  const assignee: RecipientSpec = { kind: 'USER', userId: parties.assigneeId };
  const head: RecipientSpec = {
    kind: 'DEPARTMENT_HEADS',
    departmentId: parties.departmentId,
    includeDeputy: false,
  };
  return type === 'STAGE_DUE_SOON'
    ? [{ kind: 'FIRST_OF', specs: [assignee, head] }]
    : [assignee, head];
}

/** O que o texto do aviso cita da passagem (RN-NTF-32), lido no banco do tenant do evento. */
export interface StageDeadlineDetails {
  /** Nome da etapa no fluxo (`WorkflowStage.name`); nulo = passagem não encontrada. */
  readonly stageName: string | null;
  /**
   * US-125 (RN-WF2-35): rótulo do ramo da passagem (nome da primeira etapa do ramo na versão —
   * RN-WF2-07); ausente fora do paralelismo.
   */
  readonly branchLabel?: string;
  /** Fuso do tenant (DEC-003) para formatar `dueAt`/`overdueSince`. */
  readonly timezone: string;
}

/** Fonte dos detalhes da passagem (módulos `process`/`workflow` e `tenancy`). */
export interface StageDeadlineSource {
  details(
    client: SqlClient,
    tenantId: string,
    processStageId: string,
  ): Promise<StageDeadlineDetails>;
}

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/**
 * Leitura com o papel `cf_worker` dentro da `tenantTransaction` do despacho (a RLS restringe ao
 * tenant do evento: passagem de outro tenant simplesmente não é encontrada — V-03).
 */
export class SqlStageDeadlineSource implements StageDeadlineSource {
  async details(
    client: SqlClient,
    tenantId: string,
    processStageId: string,
  ): Promise<StageDeadlineDetails> {
    const stage = await client.query<{
      stage_name: string;
      branch_key?: string | null;
      branch_label?: string | null;
    }>(
      `SELECT ws.name AS stage_name, ps.branch_key, wb.name AS branch_label
         FROM process_stages ps
         JOIN workflow_stages ws ON ws.id = ps.workflow_stage_id AND ws.tenant_id = ps.tenant_id
         LEFT JOIN workflow_stages wb
                ON wb.tenant_id = ps.tenant_id AND wb.workflow_version_id = ws.workflow_version_id
               AND wb.key = ps.branch_key
        WHERE ps.id = $1 AND ps.tenant_id = $2`,
      [processStageId, tenantId],
    );
    const tenant = await client.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [tenantId],
    );
    const row = stage.rows[0];
    const branchKey = row?.branch_key ?? null;
    return {
      stageName: row?.stage_name ?? null,
      timezone: tenant.rows[0]?.timezone ?? DEFAULT_TIMEZONE,
      ...(branchKey === null ? {} : { branchLabel: row?.branch_label ?? branchKey }),
    };
  }
}

/** `dd/mm/aaaa` no fuso do tenant (DEC-003); entrada inválida = nulo. */
export function formatTenantDate(instant: string | null, timezone: string): string | null {
  if (instant === null) return null;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const [year, month, day] = localDateOf(date, timezone).split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** `dd/mm/aaaa às HH:mm` no fuso do tenant (DEC-003); entrada inválida = nulo. */
export function formatTenantDateTime(instant: string | null, timezone: string): string | null {
  const day = formatTenantDate(instant, timezone);
  if (day === null || instant === null) return null;
  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
  return `${day} às ${time}`;
}
