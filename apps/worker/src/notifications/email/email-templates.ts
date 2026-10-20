import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  isNotificationType,
  isRelativeNotificationLink,
  scrubNotificationText,
} from '@contrataflow/types';
import type { NotificationType } from '@contrataflow/types';

/*
 * `EmailTemplateRegistry` (US-112 · RN-NTF-15): um template pt-BR por `NotificationType` — assunto,
 * HTML acessível e texto simples, SEMPRE enviados juntos. O conteúdo segue a régua da central in-app
 * (RN-NTF-07 · POL-09): reaproveita o título e o corpo já gravados na notificação (rótulos fixos,
 * sem valores nem nomes de terceiros), mascara de novo por defesa em profundidade e acrescenta só
 * textos fixos do tipo — a chamada para ação e o motivo do aviso. Quem precisa do detalhe abre o
 * link, que exige login.
 */

export interface EmailTemplate {
  /** Rótulo do botão (chamada para ação). */
  readonly action: string;
  /** Por que a pessoa recebeu o aviso (rodapé). */
  readonly reason: string;
}

const PROCESS_REASON = 'Você recebe este aviso porque participa deste processo.';
/** US-114: o responsável da etapa ou o titular da unidade dela (escalonamento do atraso). */
const STAGE_REASON =
  'Você recebe este aviso porque a etapa está sob sua responsabilidade ou da unidade que você chefia.';

export const EMAIL_TEMPLATES: Readonly<Record<NotificationType, EmailTemplate>> = Object.freeze({
  PROCESS_RECEIVED: {
    action: 'Abrir o processo',
    reason: 'Você recebe este aviso porque o processo chegou para você ou para a sua unidade.',
  },
  PROCESS_RETURNED: { action: 'Ver o motivo da devolução', reason: PROCESS_REASON },
  PROCESS_ASSIGNED: {
    action: 'Abrir o processo',
    reason: 'Você recebe este aviso porque foi definido como responsável pelo processo.',
  },
  PROCESS_STATUS_CHANGED: { action: 'Abrir o processo', reason: PROCESS_REASON },
  APPROVAL_REQUESTED: {
    action: 'Decidir a aprovação',
    reason: 'Você recebe este aviso porque a aprovação aguarda a sua decisão.',
  },
  APPROVAL_DECIDED: { action: 'Ver a decisão', reason: PROCESS_REASON },
  APPROVAL_REASSIGNED: { action: 'Ver a aprovação', reason: PROCESS_REASON },
  MENTIONED: {
    action: 'Ver o comentário',
    reason: 'Você recebe este aviso porque mencionaram você ou a sua unidade.',
  },
  COMMENT_REPLY: {
    action: 'Ver a resposta',
    reason: 'Você recebe este aviso porque responderam a um comentário seu.',
  },
  STAGE_DUE_SOON: { action: 'Abrir o processo', reason: STAGE_REASON },
  STAGE_OVERDUE: { action: 'Abrir o processo', reason: STAGE_REASON },
  PARTICIPANT_ADDED: {
    action: 'Abrir o processo',
    reason: 'Você recebe este aviso porque foi incluído como participante do processo.',
  },
  ATTACHMENT_REJECTED: {
    action: 'Abrir o processo',
    reason: 'Você recebe este aviso porque enviou o arquivo.',
  },
  DOCUMENT_RENDER_FAILED: {
    action: 'Abrir o documento',
    reason: 'Você recebe este aviso porque pediu a geração do PDF.',
  },
  AI_GENERATION_READY: {
    action: 'Abrir o documento',
    reason: 'Você recebe este aviso porque pediu uma geração com IA.',
  },
  AI_GENERATION_FAILED: {
    action: 'Abrir o documento',
    reason: 'Você recebe este aviso porque pediu uma geração com IA.',
  },
  AI_USAGE_LIMIT_WARNING: {
    action: 'Abrir as configurações',
    reason: 'Você recebe este aviso porque administra as configurações do órgão.',
  },
  ROLE_CHANGED: {
    action: 'Acessar o ContrataFlow',
    reason:
      'Este aviso é obrigatório: alterações nos seus perfis de acesso sempre são comunicadas por e-mail.',
  },
});

/** Notificação a renderizar (colunas de `notifications`). */
export interface EmailTemplateInput {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const PRODUCT = 'ContrataFlow';
const SUBJECT_MAX = 150;
const FALLBACK_LINK = '/notificacoes';
const AUTOMATIC_NOTICE =
  'Este é um e-mail automático; não responda. Os avisos também ficam na central de notificações do ContrataFlow, onde você pode ajustar quais deles chegam por e-mail.';

/** Escapa texto para HTML (conteúdo e atributos). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Assunto em uma linha só (sem quebras — evita injeção de cabeçalho), com limite. */
function subjectOf(title: string): string {
  const oneLine = title.replace(/[\r\n\t]+/g, ' ').trim();
  return scrubNotificationText(`[${PRODUCT}] ${oneLine}`, SUBJECT_MAX);
}

/** URL absoluta do link relativo da notificação (RN-NTF-08); inválido → central de notificações. */
export function absoluteLink(baseUrl: string, link: string | null): string {
  const path = link !== null && isRelativeNotificationLink(link) ? link : FALLBACK_LINK;
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export class EmailTemplateRegistry {
  constructor(
    private readonly baseUrl: string,
    private readonly templates: Readonly<Record<string, EmailTemplate>> = EMAIL_TEMPLATES,
  ) {}

  has(type: string): boolean {
    return isNotificationType(type) && Object.hasOwn(this.templates, type);
  }

  /** E-mail do tipo; `null` quando o tipo não tem template (FA-03 — `FAILED` "template ausente"). */
  render(input: EmailTemplateInput): RenderedEmail | null {
    const template = this.has(input.type) ? this.templates[input.type] : undefined;
    if (!template) return null;
    const title = scrubNotificationText(input.title, NOTIFICATION_TITLE_MAX);
    const body = scrubNotificationText(input.body, NOTIFICATION_BODY_MAX);
    const url = absoluteLink(this.baseUrl, input.link);
    return {
      subject: subjectOf(title),
      text: [
        title,
        '',
        body,
        '',
        `${template.action}: ${url}`,
        '',
        '—',
        template.reason,
        AUTOMATIC_NOTICE,
      ].join('\n'),
      html: renderHtml({ title, body, url, action: template.action, reason: template.reason }),
    };
  }
}

/*
 * HTML básico e acessível: `lang="pt-BR"`, título do documento, sem imagens (nada de texto
 * alternativo a perder), contraste AA (#1f2937, #4b5563 e o navy #141e2b sobre branco; branco sobre o
 * azul profundo da marca #004be3 — DEC-185) e link com texto descritivo. Estilos inline — clientes
 * de e-mail descartam `<style>`.
 */
function renderHtml(parts: {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly action: string;
  readonly reason: string;
}): string {
  const title = escapeHtml(parts.title);
  const url = escapeHtml(parts.url);
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title></head>`,
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    '<main style="max-width:560px;margin:0 auto">',
    `<p style="margin:0 0 16px;font-size:14px;font-weight:bold;color:#141e2b">${PRODUCT}</p>`,
    `<h1 style="margin:0 0 12px;font-size:20px;color:#1f2937">${title}</h1>`,
    `<p style="margin:0 0 24px">${escapeHtml(parts.body)}</p>`,
    `<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#004be3;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${escapeHtml(parts.action)}</a></p>`,
    `<p style="margin:0 0 24px;font-size:14px;color:#4b5563">Se o botão não funcionar, copie e cole este endereço no navegador: <a href="${url}" style="color:#004be3">${url}</a></p>`,
    '<hr style="border:none;border-top:1px solid #d1d5db;margin:24px 0">',
    `<p style="margin:0 0 8px;font-size:13px;color:#4b5563">${escapeHtml(parts.reason)}</p>`,
    `<p style="margin:0;font-size:13px;color:#4b5563">${escapeHtml(AUTOMATIC_NOTICE)}</p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}
