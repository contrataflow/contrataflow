import { APPROVAL_LIST_READER } from '#modules/approval/application/ports.js';
import type { ApprovalListRow } from '#modules/approval/domain/approval-list.js';
import { InMemoryApprovalListReader } from '#modules/approval/infrastructure/approval-list.readers.js';
import { INBOX_CLOCK, INBOX_READER } from '#modules/inbox/application/ports.js';
import type { InboxProcessRow } from '#modules/inbox/domain/task-inbox.js';
import { InMemoryInboxReader } from '#modules/inbox/infrastructure/task-inbox.readers.js';

/*
 * Apoio dos testes de rota dos ramos paralelos nas leituras (US-125): os leitores em memória da
 * caixa de tarefas (`v_inbox_processes`) e da lista de aprovações (APV-01) — internos de `inbox` e
 * `approval` que a suíte do `process` não importa diretamente (DEC-040).
 */

export {
  APPROVAL_LIST_READER,
  INBOX_CLOCK,
  INBOX_READER,
  InMemoryApprovalListReader,
  InMemoryInboxReader,
};
export type { ApprovalListRow, InboxProcessRow };
