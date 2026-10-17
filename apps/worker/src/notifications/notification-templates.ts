import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  scrubNotificationText,
} from '@contrataflow/types';
import type { NotificationType } from '@contrataflow/types';

/*
 * Templates das notificações in-app (queues.md §4.2 · RN-NTF-07): pt-BR, só rótulos fixos — nada
 * de valores, nomes de terceiros nem trechos do processo (POL-09). Quem precisa do detalhe abre o
 * link. `variant` distingue as especializações do mesmo tipo (decisão, situação, perfil).
 */

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

export interface TemplateInput {
  /** Eventos agregados na notificação (agrupamento de 5 min — RN-NTF-04). */
  readonly groupCount: number;
  readonly variant?: string | undefined;
}

type Template = (input: TemplateInput) => NotificationContent;

/** Sufixo padrão do agrupamento: "(3 avisos neste processo)". */
const grouped = (body: string, count: number) =>
  count > 1 ? `${body} (${String(count)} avisos neste processo)` : body;

const STATUS_TITLES: Readonly<Record<string, string>> = {
  suspended: 'Processo suspenso',
  resumed: 'Processo retomado',
  canceled: 'Processo cancelado',
  completed: 'Processo concluído',
};

const DECISION_TITLES: Readonly<Record<string, string>> = {
  approved: 'Aprovação concluída',
  returned: 'Aprovação devolvida',
  rejected: 'Aprovação rejeitada',
};

const TEMPLATES: Readonly<Record<NotificationType, Template>> = {
  PROCESS_RECEIVED: ({ groupCount }) => ({
    title: 'Processo recebido',
    body: grouped(
      'Um processo chegou para você ou para a sua unidade. Abra-o para dar andamento.',
      groupCount,
    ),
  }),
  PROCESS_RETURNED: ({ groupCount }) => ({
    title: 'Processo devolvido',
    body: grouped('Um processo foi devolvido para ajustes. Abra-o para ver o motivo.', groupCount),
  }),
  PROCESS_ASSIGNED: ({ groupCount }) => ({
    title: 'Processo atribuído a você',
    body: grouped('Você é o novo responsável por um processo.', groupCount),
  }),
  PROCESS_STATUS_CHANGED: ({ groupCount, variant }) => ({
    title: STATUS_TITLES[variant ?? ''] ?? 'Situação do processo alterada',
    body: grouped('A situação de um processo que você acompanha mudou.', groupCount),
  }),
  APPROVAL_REQUESTED: ({ groupCount }) => ({
    title: 'Aprovação pendente',
    body: grouped('Há uma aprovação aguardando a sua decisão.', groupCount),
  }),
  APPROVAL_DECIDED: ({ groupCount, variant }) => ({
    title: DECISION_TITLES[variant ?? ''] ?? 'Aprovação decidida',
    body: grouped('Uma aprovação que envolve você foi decidida.', groupCount),
  }),
  APPROVAL_REASSIGNED: ({ groupCount }) => ({
    title: 'Aprovação redirecionada',
    body: grouped('Uma aprovação que envolve você foi redirecionada.', groupCount),
  }),
  MENTIONED: ({ groupCount }) => ({
    title: 'Você foi mencionado',
    body:
      groupCount > 1
        ? `Mencionaram você (ou a sua unidade) ${String(groupCount)} vezes em comentários deste processo.`
        : 'Mencionaram você (ou a sua unidade) em um comentário.',
  }),
  COMMENT_REPLY: ({ groupCount }) => ({
    title: 'Nova resposta ao seu comentário',
    body:
      groupCount > 1
        ? `Há ${String(groupCount)} novas respostas a comentários seus neste processo.`
        : 'Responderam a um comentário seu.',
  }),
  STAGE_DUE_SOON: ({ groupCount }) => ({
    title: 'Prazo da etapa perto do fim',
    body: grouped('O prazo de uma etapa sob sua responsabilidade está terminando.', groupCount),
  }),
  STAGE_OVERDUE: ({ groupCount }) => ({
    title: 'Prazo da etapa vencido',
    body: grouped('O prazo de uma etapa sob sua responsabilidade venceu.', groupCount),
  }),
  PARTICIPANT_ADDED: ({ groupCount }) => ({
    title: 'Você agora participa de um processo',
    body: grouped(
      'Você (ou a sua unidade) foi incluído como participante de um processo.',
      groupCount,
    ),
  }),
  ATTACHMENT_REJECTED: ({ groupCount, variant }) => ({
    title: 'Anexo recusado',
    body: grouped(
      variant === 'infected'
        ? 'O arquivo enviado foi recusado pela verificação de segurança e não foi armazenado.'
        : 'O arquivo enviado foi recusado e não foi armazenado.',
      groupCount,
    ),
  }),
  DOCUMENT_RENDER_FAILED: ({ groupCount }) => ({
    title: 'Falha ao gerar o PDF',
    body: grouped(
      'Não foi possível gerar o PDF de um documento. Tente novamente mais tarde.',
      groupCount,
    ),
  }),
  ROLE_CHANGED: ({ variant }) => ({
    title:
      variant === 'revoked'
        ? 'Um perfil de acesso seu foi removido'
        : 'Você recebeu um novo perfil de acesso',
    body: 'Seus perfis de acesso mudaram. Se você não reconhece a alteração, procure o administrador do órgão.',
  }),
  AI_GENERATION_READY: () => ({
    title: 'Conteúdo gerado por IA pronto para revisão',
    body: 'A proposta que você pediu está pronta. Revise o texto antes de aplicar ao documento.',
  }),
  AI_GENERATION_FAILED: () => ({
    title: 'Não foi possível gerar o conteúdo com IA',
    body: 'A geração que você pediu não foi concluída. Abra o documento para tentar novamente.',
  }),
};

/** Título e corpo do tipo, já mascarados e dentro dos limites das colunas (RN-NTF-07). */
export function notificationContent(
  type: NotificationType,
  input: TemplateInput,
): NotificationContent {
  const content = TEMPLATES[type](input);
  return {
    title: scrubNotificationText(content.title, NOTIFICATION_TITLE_MAX),
    body: scrubNotificationText(content.body, NOTIFICATION_BODY_MAX),
  };
}
