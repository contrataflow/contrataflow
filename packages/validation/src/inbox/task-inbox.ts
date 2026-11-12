import { z } from 'zod';

import { APPROVAL_LINES_MAX } from '../approval/approval-approvers.js';
import { approvalProgressSchema } from '../approval/approval-progress.js';
import { APPROVAL_SUBJECT_TYPES } from '../approval/events.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { APPROVAL_DECISION_POLICIES } from '../document/approver-lines.js';
import { pageMetaSchema, pageQuerySchema } from '../http/pagination.js';
import { PROCESS_STATUSES } from '../process/process-actions.js';
import { branchRowFields } from '../process/process-branch-views.js';
import { processDeadlineSchema } from '../process/process-list.js';
import { WORKFLOW_ITEM_KEY_PATTERN } from '../workflow/workflow.js';

/*
 * Caixa de tarefas (US-056 · TSK-01/TSK-02 · SCR-013): consulta sobre as etapas/responsabilidades
 * ativas, as aprovações pendentes e as participações do usuário (DEC-026) — não é entidade. O mesmo
 * `taskInboxQuerySchema` valida a query string na API (422 `VALIDATION_ERROR`) e monta a URL no
 * front; as mensagens são as das tabelas "Casos de erro" e "Fluxos alternativos" da story.
 */

/** RN-INBOX-02: visões do parâmetro `view` (padrão `MINE`). */
export const TASK_INBOX_VIEWS = [
  'MINE',
  'UNIT_QUEUE',
  'PENDING_APPROVALS',
  'RETURNED',
  'OVERDUE',
  'FOLLOWING',
] as const;
export type TaskInboxView = (typeof TASK_INBOX_VIEWS)[number];

export const TASK_INBOX_DEFAULT_VIEW: TaskInboxView = 'MINE';
export const TASK_INBOX_DEFAULT_SORT = '-dueAt';
export const TASK_INBOX_DEFAULT_PAGE_SIZE = 20;
/** RN-INBOX-13: intervalo do polling de contadores e da aba ativa. */
export const TASK_INBOX_POLL_INTERVAL_MS = 60_000;

export const TASK_INBOX_SORT_FIELDS = ['dueAt', 'code', 'enteredAt', 'requestedAt'] as const;
export type TaskInboxSortField = (typeof TASK_INBOX_SORT_FIELDS)[number];

/**
 * RN-INBOX-10: campos ordenáveis por visão — prazo, código e a data de entrada na etapa; em
 * "Aprovações pendentes", a data da solicitação no lugar da entrada na etapa.
 */
export function taskInboxSortFieldsOf(view: TaskInboxView): readonly TaskInboxSortField[] {
  return view === 'PENDING_APPROVALS'
    ? ['dueAt', 'code', 'requestedAt']
    : ['dueAt', 'code', 'enteredAt'];
}

export interface TaskInboxSort {
  readonly field: TaskInboxSortField;
  readonly direction: 'asc' | 'desc';
}

/** `-campo` = decrescente; `null` = texto fora do formato ou campo não permitido na visão. */
export function parseTaskInboxSort(value: string, view: TaskInboxView): TaskInboxSort | null {
  const match = /^(-?)([A-Za-z]+)$/.exec(value);
  if (!match) return null;
  const field = match[2] as TaskInboxSortField;
  if (!taskInboxSortFieldsOf(view).includes(field)) return null;
  return { field, direction: match[1] === '-' ? 'desc' : 'asc' };
}

/** `TaskInboxSort` → texto do parâmetro `sort`. */
export function formatTaskInboxSort(sort: TaskInboxSort): string {
  return `${sort.direction === 'desc' ? '-' : ''}${sort.field}`;
}

export const TASK_INBOX_MESSAGES = Object.freeze({
  invalidSort: 'Ordenação inválida para a visão.',
  forbidden: 'Você não tem acesso à caixa de tarefas.',
  unavailable: 'Não foi possível carregar sua caixa de tarefas agora.',
  alreadyClaimed: 'Este processo já foi assumido por outra pessoa.',
  reload: 'Atualize a página e tente novamente.',
  rateLimited: 'Muitas tentativas. Aguarde alguns segundos.',
});

/**
 * TSK-01 — `?view=&page=&pageSize=&sort=&branchKey=` (V-01..V-03). US-125 (aditivo): `branchKey`
 * restringe às linhas daquele ramo (filtro local da tela — V-02 fora do formato da chave).
 */
export const taskInboxQuerySchema = pageQuerySchema
  .extend({
    view: z.enum(TASK_INBOX_VIEWS).default(TASK_INBOX_DEFAULT_VIEW),
    sort: z.string().max(40).default(TASK_INBOX_DEFAULT_SORT),
    branchKey: z.string().max(60).regex(WORKFLOW_ITEM_KEY_PATTERN).optional(),
  })
  .transform((query, context) => {
    const sort = parseTaskInboxSort(query.sort, query.view);
    if (sort === null) {
      context.addIssue({
        code: 'custom',
        path: ['sort'],
        message: TASK_INBOX_MESSAGES.invalidSort,
        params: { code: 'INVALID_ENUM' },
      });
      return z.NEVER;
    }
    return {
      view: query.view,
      page: query.page,
      pageSize: query.pageSize,
      sort,
      branchKey: query.branchKey ?? null,
    };
  })
  .meta({ id: 'TaskInboxQuery' });
export type TaskInboxQuery = z.output<typeof taskInboxQuerySchema>;

const unitRefSchema = z.object({ id: z.uuid(), name: z.string() });
const userRefSchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * Aprovação pendente da linha (só na visão `PENDING_APPROVALS`). US-136 (aditivo · RN-APV-62): a
 * linha de aprovação (`ApprovalApprover` `PENDING`) que cabe a quem consulta, a ordem, a política e
 * o andamento (RN-APV-70); `id` continua sendo a `Approval`.
 */
export const taskInboxApprovalSchema = z
  .object({
    id: z.uuid(),
    approvalApproverId: z.uuid().optional(),
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX).optional(),
    decisionPolicy: z.enum(APPROVAL_DECISION_POLICIES).optional(),
    progress: approvalProgressSchema.optional(),
    title: z.string(),
    subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
    requestedBy: userRefSchema,
    requestedAt: isoDateTimeSchema,
    dueAt: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'TaskInboxApproval' });

/** Linha da caixa de tarefas (TSK-01). Sem valores monetários (FA-05). */
export const taskInboxItemSchema = z
  .object({
    /**
     * Chave da linha: o processo; em `PENDING_APPROVALS`, a linha de aprovação
     * (`approvalApproverId` — US-136 · RN-APV-62).
     */
    id: z.uuid(),
    processId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(PROCESS_STATUSES),
    /** `If-Match` do "Assumir" (PRC-21). */
    version: z.int().min(1),
    currentStage: z.object({ key: z.string(), name: z.string() }).nullable(),
    currentDepartment: unitRefSchema,
    currentResponsible: userRefSchema.nullable(),
    /** Entrada na etapa ativa. */
    enteredAt: isoDateTimeSchema.nullable(),
    /**
     * Prazo da etapa ativa; em `PENDING_APPROVALS`, o da linha, senão o da aprovação, senão o da
     * etapa (US-136 · RN-APV-63).
     */
    dueAt: isoDateTimeSchema.nullable(),
    /** Derivado de `overdueSince` da etapa ativa. */
    isOverdue: z.boolean(),
    overdueSince: isoDateTimeSchema.nullable(),
    deadline: processDeadlineSchema,
    isBudgetConfidential: z.boolean(),
    /** RN-INBOX-11: a ação rápida "Assumir" está disponível para quem consulta. */
    canClaim: z.boolean(),
    approval: taskInboxApprovalSchema.optional(),
    /**
     * US-125 (aditivo · RN-WF2-30): chave única da linha — `processId` fora de ramo,
     * `processId:processStageId` na linha de um ramo, a linha de aprovação em
     * `PENDING_APPROVALS`. Com ramos, `currentStage`, `currentDepartment`, `currentResponsible`,
     * `enteredAt`, `dueAt`, `isOverdue`, `overdueSince`, `deadline` e `canClaim` descrevem a etapa
     * da linha.
     */
    rowKey: z.string().optional(),
    /** Etapa ativa da linha (o alvo do "Assumir" — PRC-21); `null` sem etapa ativa. */
    processStageId: z.uuid().nullable().optional(),
    /** Etapas ativas do processo (1 fora do paralelismo). */
    activeStagesCount: z.int().min(0).optional(),
    ...branchRowFields,
  })
  .meta({ id: 'TaskInboxItem' });
export type TaskInboxItemDto = z.infer<typeof taskInboxItemSchema>;

export const taskInboxResponseSchema = z.object({
  data: z.array(taskInboxItemSchema),
  meta: pageMetaSchema,
});
export type TaskInboxResponse = z.infer<typeof taskInboxResponseSchema>;

/** TSK-02 — contadores por visão (RN-INBOX-09); `unitQueue` só quando a fila se aplica. */
export const taskInboxCountersSchema = z
  .object({
    mine: z.int().min(0),
    unitQueue: z.int().min(0).optional(),
    pendingApprovals: z.int().min(0),
    returned: z.int().min(0),
    overdue: z.int().min(0),
    following: z.int().min(0),
  })
  .meta({ id: 'TaskInboxCounters' });
export type TaskInboxCountersDto = z.infer<typeof taskInboxCountersSchema>;

/** US-125 (RN-WF2-31): os contadores contam LINHAS (um processo com dois ramos visíveis conta 2). */
export const TASK_INBOX_COUNT_UNIT = 'ROW' as const;

export const taskInboxCountersResponseSchema = z.object({
  data: taskInboxCountersSchema,
  meta: z.object({ countUnit: z.literal(TASK_INBOX_COUNT_UNIT) }).optional(),
});

/** Chave do contador de cada visão. */
export const TASK_INBOX_COUNTER_KEYS: Readonly<Record<TaskInboxView, keyof TaskInboxCountersDto>> =
  {
    MINE: 'mine',
    UNIT_QUEUE: 'unitQueue',
    PENDING_APPROVALS: 'pendingApprovals',
    RETURNED: 'returned',
    OVERDUE: 'overdue',
    FOLLOWING: 'following',
  };
