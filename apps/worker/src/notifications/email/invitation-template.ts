import { escapeHtml } from './email-templates.js';
import type { RenderedEmail } from './email-templates.js';

/*
 * Template pt-BR do convite de usuário (US-091 · USR-03/04): assunto, texto e HTML enviados
 * juntos, no mesmo estilo de `email-templates.ts`. O link carrega o token em claro — por isso o
 * conteúdo renderizado nunca é logado; só o hash do token chega ao banco.
 */

const PRODUCT = 'ContrataFlow';
const ACTION = 'Aceitar convite';
const SUBJECT_MAX = 150;
const TIME_ZONE = 'America/Sao_Paulo';
const PASSWORD_NOTICE =
  'Se ainda não tem senha no ContrataFlow, você vai defini-la no primeiro acesso. Se não esperava este convite, ignore este e-mail.';
const AUTOMATIC_NOTICE = 'Este é um e-mail automático; não responda.';

export interface InvitationEmailInput {
  /** Nome completo do convidado (`users.name`); só o primeiro nome vai na saudação. */
  readonly name: string | null;
  readonly tenantName: string;
  readonly jobTitle: string | null;
  /** Token em claro (43 caracteres base64url) — entra só no link. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** Texto em uma linha só (sem quebras — evita injeção de cabeçalho no assunto). */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Primeiro nome para a saudação; vazio quando não há nome. */
export function firstNameOf(name: string | null | undefined): string {
  return oneLine(name ?? '').split(' ')[0] ?? '';
}

/** `dd/mm/aaaa HH:mm` em `America/Sao_Paulo` (sem vírgula nem segundos). */
export function formatInvitationDeadline(date: Date): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/** Link absoluto do convite: `{appBaseUrl}/convite/{token}`. */
export function invitationLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/convite/${token}`;
}

export function renderInvitationEmail(baseUrl: string, input: InvitationEmailInput): RenderedEmail {
  const tenant = oneLine(input.tenantName);
  const jobTitle = oneLine(input.jobTitle ?? '');
  const first = firstNameOf(input.name);
  const url = invitationLink(baseUrl, input.token);
  const deadline = formatInvitationDeadline(input.expiresAt);

  const subject = `Convite para acessar o ${PRODUCT} — ${tenant}`.slice(0, SUBJECT_MAX);
  const greeting = first ? `Olá, ${first}!` : 'Olá!';
  const intro = `Você foi convidado(a) para acessar o ${PRODUCT} em ${tenant}.`;
  const role = jobTitle ? `Cargo informado no convite: ${jobTitle}.` : null;
  const validity = `O convite vale até ${deadline} (horário de Brasília).`;

  const text = [
    greeting,
    '',
    intro,
    ...(role ? [role] : []),
    '',
    `${ACTION}: ${url}`,
    '',
    validity,
    '',
    '—',
    PASSWORD_NOTICE,
    AUTOMATIC_NOTICE,
  ].join('\n');

  const safeUrl = escapeHtml(url);
  const html = [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    '<main style="max-width:560px;margin:0 auto">',
    `<p style="margin:0 0 16px;font-size:14px;font-weight:bold;color:#141e2b">${PRODUCT}</p>`,
    `<h1 style="margin:0 0 12px;font-size:20px;color:#1f2937">${escapeHtml(greeting)}</h1>`,
    `<p style="margin:0 0 12px">${escapeHtml(intro)}</p>`,
    ...(role ? [`<p style="margin:0 0 12px">${escapeHtml(role)}</p>`] : []),
    `<p style="margin:12px 0 24px"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#004be3;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${ACTION}</a></p>`,
    `<p style="margin:0 0 24px">${escapeHtml(validity)}</p>`,
    `<p style="margin:0 0 24px;font-size:14px;color:#4b5563">Se o botão não funcionar, copie e cole este endereço no navegador: <a href="${safeUrl}" style="color:#004be3">${safeUrl}</a></p>`,
    '<hr style="border:none;border-top:1px solid #d1d5db;margin:24px 0">',
    `<p style="margin:0 0 8px;font-size:13px;color:#4b5563">${escapeHtml(PASSWORD_NOTICE)}</p>`,
    `<p style="margin:0;font-size:13px;color:#4b5563">${escapeHtml(AUTOMATIC_NOTICE)}</p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');

  return { subject, text, html };
}
