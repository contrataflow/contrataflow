// Recuperação de senha de ponta a ponta contra o Authentik local (US-089): percorre o flow
// `contrataflow-recovery` pela API do executor (a mesma que a interface usa), lê o link do e-mail
// no Mailpit e redefine a senha. A conta usada é temporária, criada e apagada pela API de
// administração do Authentik com o token de bootstrap (só ambiente local/CI — RN-FND-19).
import { randomBytes, randomUUID } from 'node:crypto';

import { CookieJar } from './oidc.js';
import type { FetchLike } from './oidc.js';

export const RECOVERY_FLOW_SLUG = 'contrataflow-recovery';

/** Pasta dos usuários temporários no Authentik (fora de `contrataflow/dev`, a do seed). */
export const TEMP_USER_PATH = 'contrataflow/teste';

export interface FlowChallenge {
  readonly component: string;
  readonly to?: string;
  readonly token?: string;
  readonly flow_info?: { readonly title?: string };
  readonly response_errors?: Readonly<Record<string, readonly { readonly string: string }[]>>;
}

/** Senha forte e inédita (fora de qualquer vazamento conhecido). */
export function strongPassword(): string {
  return `Cf-${randomBytes(15).toString('base64url')}`;
}

/** Um navegador: cookies próprios, a página do flow e o executor de fluxos do Authentik. */
export class FlowBrowser {
  private readonly jar = new CookieJar();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookies = this.jar.header();
    if (cookies) headers.set('Cookie', cookies);
    const csrf = this.jar.get('authentik_csrf');
    if (csrf) headers.set('X-authentik-CSRF', csrf);
    const response = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
    this.jar.store(response);
    return response;
  }

  private executor(slug: string, query: string): string {
    return `${this.baseUrl}/api/v3/flows/executor/${slug}/?query=${encodeURIComponent(query)}`;
  }

  /** O executor responde POST com 302 para o próprio GET (às vezes encadeado). */
  private async challenge(slug: string, query: string, first: Response): Promise<FlowChallenge> {
    let response = first;
    for (let hop = 0; hop < 10; hop += 1) {
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) {
        return (await response.json()) as FlowChallenge;
      }
      const next = new URL(location, this.executor(slug, query));
      if (!next.pathname.startsWith('/api/v3/flows/executor/')) {
        return { component: 'xak-flow-redirect', to: next.toString() };
      }
      response = await this.request(next.toString());
    }
    throw new Error(`redirecionamentos demais no executor do fluxo ${slug}`);
  }

  /** Página HTML do flow (o que o navegador recebe ao seguir o redirecionamento do BFF). */
  async page(slug: string, query = ''): Promise<Response> {
    return this.request(`${this.baseUrl}/if/flow/${slug}/${query ? `?${query}` : ''}`);
  }

  /** Abre o flow como o navegador (página + primeiro desafio). */
  async open(slug: string, query = ''): Promise<FlowChallenge> {
    const page = await this.page(slug, query);
    if (page.status !== 200) throw new Error(`/if/flow/${slug}/ respondeu HTTP ${page.status}`);
    await page.body?.cancel();
    return this.challenge(slug, query, await this.request(this.executor(slug, query)));
  }

  async submit(
    slug: string,
    query: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<FlowChallenge> {
    const response = await this.request(this.executor(slug, query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return this.challenge(slug, query, response);
  }
}

/** Query do link do e-mail (`flow_token=…`), a partir da URL completa. */
export function linkQuery(link: string): string {
  return new URL(link).search.slice(1);
}

/** Pede a recuperação para o e-mail informado; devolve o desafio depois do e-mail. */
export async function requestRecovery(
  browser: FlowBrowser,
  email: string,
): Promise<{ readonly first: FlowChallenge; readonly afterEmail: FlowChallenge }> {
  const first = await browser.open(RECOVERY_FLOW_SLUG);
  const afterEmail = await browser.submit(RECOVERY_FLOW_SLUG, '', {
    component: 'ak-stage-identification',
    uid_field: email,
  });
  return { first, afterEmail };
}

/** Abre o link do e-mail e confirma (o Authentik consome o token na confirmação). */
export async function openRecoveryLink(browser: FlowBrowser, link: string): Promise<FlowChallenge> {
  const query = linkQuery(link);
  const first = await browser.open(RECOVERY_FLOW_SLUG, query);
  if (first.component !== 'ak-stage-consent') return first;
  return browser.submit(RECOVERY_FLOW_SLUG, query, {
    component: 'ak-stage-consent',
    token: first.token,
  });
}

/** Envia a nova senha na etapa de prompt. */
export function submitNewPassword(
  browser: FlowBrowser,
  link: string,
  password: string,
  repeat = password,
): Promise<FlowChallenge> {
  return browser.submit(RECOVERY_FLOW_SLUG, linkQuery(link), {
    component: 'ak-stage-prompt',
    password,
    password_repeat: repeat,
  });
}

interface MailpitSummary {
  readonly ID: string;
  readonly To?: readonly { readonly Address: string }[];
}

async function mailpitMessages(
  mailpitUrl: string,
  email: string,
  fetchImpl: FetchLike,
): Promise<MailpitSummary[]> {
  const response = await fetchImpl(
    `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  if (!response.ok) throw new Error(`Mailpit respondeu HTTP ${response.status}`);
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

/** Quantos e-mails o Mailpit recebeu para o endereço. */
export async function mailCount(
  mailpitUrl: string,
  email: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  return (await mailpitMessages(mailpitUrl, email, fetchImpl)).length;
}

export interface RecoveryMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly link: string;
}

/** Último e-mail de recuperação do endereço (espera o envio assíncrono do worker). */
export async function recoveryMail(
  mailpitUrl: string,
  email: string,
  fetchImpl: FetchLike = fetch,
  attempts = 40,
): Promise<RecoveryMail> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [latest] = await mailpitMessages(mailpitUrl, email, fetchImpl);
    if (latest) {
      const response = await fetchImpl(`${mailpitUrl}/api/v1/message/${latest.ID}`);
      const message = (await response.json()) as { Subject: string; HTML: string; Text: string };
      const href = /id="confirm" href="([^"]+)"/.exec(message.HTML)?.[1];
      if (!href) throw new Error('e-mail de recuperação sem o link "Redefinir senha"');
      return {
        subject: message.Subject,
        html: message.HTML,
        text: message.Text,
        link: href.replaceAll('&amp;', '&'),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`nenhum e-mail de recuperação para ${email} no Mailpit`);
}

/** API de administração do Authentik (token de bootstrap) para a conta temporária. */
export interface AuthentikAdmin {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
}

export interface TempUser {
  readonly pk: number;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

async function admin(
  api: AuthentikAdmin,
  method: string,
  resource: string,
  body?: unknown,
): Promise<Response> {
  const response = await (api.fetchImpl ?? fetch)(`${api.baseUrl}/api/v3/${resource}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`Authentik respondeu HTTP ${response.status} em ${method} /api/v3/${resource}`);
  }
  return response;
}

/** Conta ativa com e-mail único e senha forte, em `contrataflow/teste`. */
export async function createTempUser(api: AuthentikAdmin): Promise<TempUser> {
  const id = randomUUID().slice(0, 8);
  const username = `recuperacao-${id}`;
  const email = `${username}@contrataflow.test`;
  const password = strongPassword();
  const created = (await (
    await admin(api, 'POST', 'core/users/', {
      username,
      name: 'Cláudia Teste',
      email,
      path: TEMP_USER_PATH,
      is_active: true,
    })
  ).json()) as { pk: number };
  await admin(api, 'POST', `core/users/${created.pk}/set_password/`, { password });
  return { pk: created.pk, username, email, password };
}

export async function deleteUser(api: AuthentikAdmin, pk: number): Promise<void> {
  await admin(api, 'DELETE', `core/users/${pk}/`);
}

/** Sessões abertas do usuário no Authentik. */
export async function authentikSessions(api: AuthentikAdmin, username: string): Promise<number> {
  const response = await admin(
    api,
    'GET',
    `core/authenticated_sessions/?user__username=${encodeURIComponent(username)}`,
  );
  return ((await response.json()) as { results: unknown[] }).results.length;
}
