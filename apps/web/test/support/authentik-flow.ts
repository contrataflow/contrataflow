// Authentik simulado no executor de fluxos (login nativo — DEC-187). Os desafios são respostas
// gravadas do Authentik 2026.8.3 local (spec-509), sem `flow_info` nem o avatar do usuário.
import { vi } from 'vitest';

import { requestUrl } from './render';

export const AK_ORIGIN = 'http://localhost:9080';
export const AK_LOGIN_FLOW = 'contrataflow-authentication';
export const AK_INVALIDATION_FLOW = 'default-invalidation-flow';
export const AK_AUTHORIZE = `${AK_ORIGIN}/application/o/authorize/`;
export const AK_CALLBACK = 'http://localhost:3000/api/auth/callback';

const EXECUTOR = `/api/v3/flows/executor/${AK_LOGIN_FLOW}/?query=`;
const INVALIDATION = `/api/v3/flows/executor/${AK_INVALIDATION_FLOW}/?query=`;

/** Respostas gravadas (GET/POST do executor). */
export const RECORDED = {
  identification: {
    component: 'ak-stage-identification',
    user_fields: ['email', 'username'],
    pending_user_identifier: null,
    password_fields: true,
    allow_show_password: true,
    flow_designation: 'authentication',
    captcha_stage: null,
    recovery_url: '/if/flow/contrataflow-recovery/',
    primary_action: 'Log in',
    sources: [],
    show_source_labels: false,
    enable_remember_me: true,
    passkey_challenge: null,
  },
  identificationFailed: {
    component: 'ak-stage-identification',
    response_errors: {
      non_field_errors: [{ string: 'Failed to authenticate.', code: 'invalid' }],
    },
    user_fields: ['email', 'username'],
    password_fields: true,
  },
  accessDenied: {
    component: 'ak-stage-access-denied',
    pending_user: 'planejamento.a',
    error_message: 'Acesso bloqueado temporariamente após tentativas inválidas.',
  },
  mfa: {
    component: 'ak-stage-authenticator-validate',
    pending_user: 'juridico.a',
    device_challenges: [{ device_class: 'totp', device_uid: '1', challenge: {}, last_used: null }],
    configuration_stages: [],
  },
  mfaFailed: {
    component: 'ak-stage-authenticator-validate',
    response_errors: {
      code: [
        {
          string: 'Invalid Token. Please ensure the time on your device is accurate and try again.',
          code: 'invalid',
        },
      ],
    },
    pending_user: 'juridico.a',
    device_challenges: [{ device_class: 'totp', device_uid: '1', challenge: {}, last_used: null }],
    configuration_stages: [],
  },
  done: { component: 'xak-flow-redirect', to: '/', final_redirect: true },
} as const;

export interface FlowCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | null;
}

interface IdpSession {
  stage: 'identification' | 'password' | 'mfa' | 'denied' | 'done';
  authenticated: boolean;
}

export interface FakeFlowIdp {
  readonly fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly calls: FlowCall[];
  /** Sessões do IdP abertas (as que o BFF deve encerrar). */
  readonly sessions: Map<string, IdpSession>;
  readonly state: {
    password: string;
    /** Código aceito na etapa de MFA; `null` = usuário sem dispositivo. */
    mfaCode: string | null;
    /** Classes de dispositivo da etapa de MFA. */
    deviceClasses: string[];
    /** Reputação no limite: o *flow* nega o acesso depois da senha. */
    locked: boolean;
    /** Senha numa etapa separada (`ak-stage-password`). */
    passwordStage: boolean;
    /** Rede fora (`fetch failed`) ou status 5xx em todas as chamadas. */
    down: boolean;
    status5xx: number | null;
    /** O `authorize` cai numa tela de consentimento em vez do callback. */
    consent: boolean;
  };
}

function json(body: unknown, setCookie: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of setCookie) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function redirect(location: string, setCookie: readonly string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of setCookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function cookieOf(headers: Headers, name: string): string | null {
  const raw = headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function createFakeFlowIdp(): FakeFlowIdp {
  const calls: FlowCall[] = [];
  const sessions = new Map<string, IdpSession>();
  let counter = 0;
  const state: FakeFlowIdp['state'] = {
    password: 'senha-correta',
    mfaCode: null,
    deviceClasses: ['totp'],
    locked: false,
    passwordStage: false,
    down: false,
    status5xx: null,
    consent: false,
  };

  const challengeFor = (session: IdpSession) => {
    switch (session.stage) {
      case 'identification':
        return RECORDED.identification;
      case 'password':
        return { component: 'ak-stage-password', allow_show_password: true };
      case 'mfa':
        return {
          ...RECORDED.mfa,
          device_challenges: state.deviceClasses.map((deviceClass, index) => ({
            device_class: deviceClass,
            device_uid: String(index + 1),
            challenge: {},
            last_used: null,
          })),
        };
      case 'denied':
        return RECORDED.accessDenied;
      case 'done':
        return RECORDED.done;
    }
  };

  const afterPassword = (session: IdpSession) => {
    if (state.locked) session.stage = 'denied';
    else if (state.mfaCode) session.stage = 'mfa';
    else {
      session.stage = 'done';
      session.authenticated = true;
    }
  };

  const handle = (
    url: URL,
    method: string,
    headers: Headers,
    body: Record<string, unknown> | null,
  ) => {
    if (state.down) throw new TypeError('fetch failed');
    if (state.status5xx) return new Response('erro', { status: state.status5xx });
    const sid = cookieOf(headers, 'authentik_session');
    const session = sid ? sessions.get(sid) : undefined;
    const path = url.pathname + url.search;

    if (path === EXECUTOR) {
      if (!session) {
        counter += 1;
        const id = `sess-${counter}`;
        sessions.set(id, { stage: 'identification', authenticated: false });
        return json(RECORDED.identification, [
          `authentik_session=${id}; HttpOnly; Path=/; SameSite=None`,
          'authentik_csrf=csrf-token; Path=/; SameSite=Lax',
        ]);
      }
      if (method === 'GET') return json(challengeFor(session));
      if (body?.component === 'ak-stage-identification' && session.stage === 'identification') {
        if (state.passwordStage) {
          session.stage = 'password';
          return redirect(EXECUTOR);
        }
        if (body.password !== state.password) return json(RECORDED.identificationFailed);
        afterPassword(session);
        return redirect(EXECUTOR);
      }
      if (body?.component === 'ak-stage-password' && session.stage === 'password') {
        if (body.password !== state.password) {
          return json({ component: 'ak-stage-password', response_errors: { password: [] } });
        }
        afterPassword(session);
        return redirect(EXECUTOR);
      }
      if (body?.component === 'ak-stage-authenticator-validate' && session.stage === 'mfa') {
        if (body.code !== state.mfaCode) return json(RECORDED.mfaFailed);
        session.stage = 'done';
        session.authenticated = true;
        return redirect(EXECUTOR);
      }
      return json(challengeFor(session));
    }

    if (path === INVALIDATION) {
      if (sid) sessions.delete(sid);
      return json(RECORDED.done, [
        'authentik_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/',
      ]);
    }

    if (url.href.startsWith(AK_AUTHORIZE)) {
      if (!session?.authenticated) return redirect(`/if/flow/${AK_LOGIN_FLOW}/${url.search}`);
      if (state.consent) {
        return redirect(`/if/flow/default-provider-authorization-explicit-consent/${url.search}`);
      }
      const callback = new URL(AK_CALLBACK);
      callback.searchParams.set('code', `code-${sid ?? ''}`);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      return redirect(callback.href);
    }
    return new Response('não encontrado', { status: 404 });
  };

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url: url.href, headers, body });
    try {
      return Promise.resolve(handle(url, method, headers, body));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return { fetch: fetchMock, calls, sessions, state };
}
