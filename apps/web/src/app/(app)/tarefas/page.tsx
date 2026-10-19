import { TaskInboxPage } from '@/features/task-inbox/task-inbox-page';

/**
 * SCR-013 — Caixa de tarefas (`/tarefas` · US-056): as visões com contadores, lidas no cliente
 * (TSK-01/TSK-02, com polling de 60 s). Acesso por `INBOX_VIEW`; sem a permissão, o estado 403.
 */
export default function TasksRoutePage() {
  return <TaskInboxPage />;
}
