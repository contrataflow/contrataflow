// US-089 — Recuperar senha contra o Authentik real do Compose (blueprint 12) e o Mailpit: a parte
// da story que acontece inteiramente no IdP. Exige o ambiente local de pé (`pnpm env:up`); sem
// ele, a suíte é pulada. Rodar: pnpm --filter @contrataflow/tools test:integration.
// Cada cenário usa uma conta temporária (contrataflow/teste), apagada no fim.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createContext } from '../../env/lib/cli.js';
import { loadEnv, portOf } from '../../env/lib/env-file.js';
import { query } from '../../env/lib/psql.js';
import { oidcLogin } from '../../env/smoke/oidc.js';
import {
  FlowBrowser,
  RECOVERY_FLOW_SLUG,
  authentikSessions,
  createTempUser,
  deleteUser,
  mailCount,
  openRecoveryLink,
  recoveryMail,
  requestRecovery,
  strongPassword,
  submitNewPassword,
} from '../../env/smoke/recovery.js';
import type { AuthentikAdmin, TempUser } from '../../env/smoke/recovery.js';
import { REPO_ROOT } from '../../lib/workspace.js';

const env = existsSync(path.join(REPO_ROOT, '.env')) ? loadEnv(REPO_ROOT) : null;
const AUTHENTIK = `http://localhost:${env ? portOf(env, 'AUTHENTIK_PORT') : 9080}`;
const MAILPIT = `http://localhost:${env ? portOf(env, 'MAILPIT_UI_PORT') : 8025}`;
const APP = env?.APP_BASE_URL ?? 'http://localhost:3000';
const DONE_URL = `${APP}/entrar?motivo=senha-redefinida`;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

const available =
  env !== null &&
  (await reachable(`${AUTHENTIK}/if/flow/${RECOVERY_FLOW_SLUG}/`)) &&
  (await reachable(`${MAILPIT}/api/v1/info`));

const adminApi: AuthentikAdmin = {
  baseUrl: AUTHENTIK,
  token: env?.AUTHENTIK_BOOTSTRAP_TOKEN ?? '',
};
const created: TempUser[] = [];

afterAll(async () => {
  for (const user of created) await deleteUser(adminApi, user.pk);
});

async function tempUser(): Promise<TempUser> {
  const user = await createTempUser(adminApi);
  created.push(user);
  return user;
}

function login(username: string, password: string) {
  return oidcLogin({
    issuer: `${AUTHENTIK}/application/o/contrataflow/`,
    clientId: env?.OIDC_CLIENT_ID ?? '',
    clientSecret: env?.OIDC_CLIENT_SECRET ?? '',
    redirectUri: `${APP}/api/auth/callback`,
    username,
    password,
  });
}

/** Pedido + e-mail + link confirmado: devolve o navegador já na etapa da nova senha. */
async function untilNewPassword(user: TempUser) {
  const requester = new FlowBrowser(AUTHENTIK);
  const requested = await requestRecovery(requester, user.email);
  const mail = await recoveryMail(MAILPIT, user.email);
  // O link é aberto em outro navegador (o do celular, por exemplo).
  const browser = new FlowBrowser(AUTHENTIK);
  const prompt = await openRecoveryLink(browser, mail.link);
  return { requested, mail, browser, prompt };
}

/** Textos que identificariam alguma instituição (DEC-012 · RN-IAM-35). */
const INSTITUTION = /prefeitura|munic[ií]pio|c[aâ]mara|secretaria|órgão/i;

describe.skipIf(!available)('Feature: Recuperar senha no Authentik (US-089)', () => {
  it('[Sucesso] Cláudia pede, recebe o e-mail, define a nova senha, volta a SCR-001 e entra com ela', async () => {
    const user = await tempUser();
    const { requested, mail, browser, prompt } = await untilNewPassword(user);

    // Passo 3: formulário "Esqueceu sua senha?" do ContrataFlow; passo 4: e-mail enviado.
    expect(requested.first).toMatchObject({
      component: 'ak-stage-identification',
      flow_info: { title: 'Esqueceu sua senha?' },
    });
    expect(requested.afterEmail.component).toBe('ak-stage-email');
    expect(mail.subject).toBe('Redefinição de senha do ContrataFlow');
    expect(mail.text).toContain('O link vale por 30 minutos e só pode ser usado uma vez.');
    expect(mail.link).toMatch(
      new RegExp(`^${AUTHENTIK}/if/flow/${RECOVERY_FLOW_SLUG}/\\?flow_token=[\\w-]+$`),
    );
    expect(prompt.component).toBe('ak-stage-prompt');

    // Passos 5–6: nova senha válida → /entrar?motivo=senha-redefinida, fim do fluxo, sem sessão.
    const password = strongPassword();
    const done = await submitNewPassword(browser, mail.link, password);
    expect(done).toMatchObject({ component: 'xak-flow-redirect', to: DONE_URL });
    expect(await authentikSessions(adminApi, user.username)).toBe(0);
    // Nada fica pendente neste navegador: um novo pedido recomeça do e-mail.
    expect((await browser.open(RECOVERY_FLOW_SLUG)).component).toBe('ak-stage-identification');

    // Passo 7: login normal com a nova senha; a antiga não vale mais.
    const result = await login(user.username, password);
    expect(result.claims.email).toBe(user.email);
    await expect(login(user.username, user.password)).rejects.toThrow();
  });

  it('[Validação] senha "123456789012" (vazada) e senha curta são recusadas; a anterior continua válida', async () => {
    const user = await tempUser();
    const { mail, browser } = await untilNewPassword(user);

    const leaked = await submitNewPassword(browser, mail.link, '123456789012');
    expect(leaked.component).toBe('ak-stage-prompt');
    expect(JSON.stringify(leaked.response_errors)).toMatch(/\d+/);

    const short = await submitNewPassword(browser, mail.link, 'Curta-9x');
    expect(short.component).toBe('ak-stage-prompt');
    expect(JSON.stringify(short.response_errors)).toContain(
      'Escolha uma senha com pelo menos 12 caracteres, que não tenha sido exposta em vazamentos conhecidos.',
    );

    const different = await submitNewPassword(browser, mail.link, strongPassword(), 'outra');
    expect(different.component).toBe('ak-stage-prompt');

    expect((await login(user.username, user.password)).claims.email).toBe(user.email);
  });

  it('[Permissão] o link só troca a senha: nenhuma sessão nasce dele e as anteriores são encerradas', async () => {
    const user = await tempUser();
    // Sessão aberta antes (outro dispositivo): sessão no IdP + refresh token do ContrataFlow.
    const before = await login(user.username, user.password);
    expect(before.refreshToken).toBeTruthy();
    expect(await authentikSessions(adminApi, user.username)).toBeGreaterThan(0);

    const { mail, browser } = await untilNewPassword(user);
    expect(await submitNewPassword(browser, mail.link, strongPassword())).toMatchObject({
      to: DONE_URL,
    });

    // RN-IAM-37 / passo 6: nada autenticado pelo link; sessões e refresh tokens anteriores revogados.
    expect(await authentikSessions(adminApi, user.username)).toBe(0);
    const refresh = await fetch(before.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: before.refreshToken ?? '',
        client_id: env?.OIDC_CLIENT_ID ?? '',
        client_secret: env?.OIDC_CLIENT_SECRET ?? '',
      }).toString(),
    });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error?: string }).error).toBe('invalid_grant');
  });

  it('[Tenant incorreto] nenhuma tela nem e-mail cita ou permite inferir uma instituição', async () => {
    const user = await tempUser();
    const page = await new FlowBrowser(AUTHENTIK).page(RECOVERY_FLOW_SLUG);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(INSTITUTION);

    const { requested, mail, prompt } = await untilNewPassword(user);
    for (const challenge of [requested.first, requested.afterEmail, prompt]) {
      expect(JSON.stringify(challenge)).not.toMatch(INSTITUTION);
      // O identificador digitado não volta na tela (show_matched_user: false).
      expect(JSON.stringify(challenge)).not.toContain(user.username);
    }
    expect(mail.text).not.toMatch(INSTITUTION);
  });

  it('[Duplicidade] e-mail não cadastrado recebe a mesma resposta genérica e nenhum e-mail sai', async () => {
    const user = await tempUser();
    const known = await requestRecovery(new FlowBrowser(AUTHENTIK), user.email);
    const unknownEmail = `nao-existe-${user.username}@contrataflow.test`;
    const unknown = await requestRecovery(new FlowBrowser(AUTHENTIK), unknownEmail);

    expect(unknown.first).toEqual(known.first);
    expect(unknown.afterEmail).toEqual(known.afterEmail);
    await recoveryMail(MAILPIT, user.email);
    expect(await mailCount(MAILPIT, unknownEmail)).toBe(0);
  });

  it('[Concorrência] o link já usado não abre de novo a troca de senha; a senha definida continua válida', async () => {
    const user = await tempUser();
    const { mail, browser } = await untilNewPassword(user);
    const password = strongPassword();
    expect((await submitNewPassword(browser, mail.link, password)).to).toBe(DONE_URL);

    // Reaberto (no mesmo ou em outro navegador): recomeça o pedido, sem etapa de nova senha.
    for (const again of [browser, new FlowBrowser(AUTHENTIK)]) {
      const reopened = await openRecoveryLink(again, mail.link);
      expect(reopened.component).toBe('ak-stage-identification');
    }
    expect((await login(user.username, password)).claims.email).toBe(user.email);
  });

  it('[Falha de banco] PostgreSQL do ContrataFlow indisponível: a redefinição conclui no Authentik', async () => {
    const user = await tempUser();
    const { psql } = createContext();
    const toggle = (allow: boolean) =>
      query(psql, `ALTER DATABASE contrataflow WITH ALLOW_CONNECTIONS ${String(allow)};`, {
        database: 'authentik',
      });
    await toggle(false);
    try {
      await expect(query(psql, 'select 1;')).rejects.toThrow(/not currently accepting connections/);
      const { mail, browser } = await untilNewPassword(user);
      const password = strongPassword();
      expect((await submitNewPassword(browser, mail.link, password)).to).toBe(DONE_URL);
      expect((await login(user.username, password)).claims.email).toBe(user.email);
    } finally {
      await toggle(true);
    }
    expect(await query(psql, 'select 1;')).toBe('1');
  });
});
