import { problemDetailsSchema, SETTING_DEFINITIONS } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { inMemoryTenantSettings } from '../../../../test/support/tenant-settings.js';
import { TENANT_MFA_POLICY } from '../application/ports.js';
import { SettingsTenantMfaPolicy } from '../infrastructure/tenant-mfa-policy.js';

/*
 * RN-IAM-42 · POL-14 — `security.mfaPolicy` lida das configurações do tenant pelo adaptador real
 * (`SettingsTenantMfaPolicy`, com cache e a fonte do `tenancy`), no pipeline HTTP completo com a
 * identidade fake. ORG-02 (`POST /organizations`, `ORGANIZATION_MANAGE` de risco alto) pela
 * administradora do órgão; SET-02 altera a política sem reiniciar a API.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const PWD = ['pwd'];
const MFA = ['pwd', 'otp'];
const KEY = 'security.mfaPolicy';

/** CNPJs válidos (DV conferido), um por criação. */
const CNPJS = [
  '11.444.777/0001-61',
  '45.997.418/0001-53',
  '33.000.167/0001-01',
  '30.000.000/0001-52',
  '40.000.000/0001-06',
  '50.000.000/0001-60',
];

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(problemDetailsSchema.parse(response.body).code).toBe(code);
}

describe('Feature: Política de MFA do tenant (RN-IAM-42)', () => {
  let api: TestApi;
  let settings: ReturnType<typeof inMemoryTenantSettings>;
  let created = 0;

  beforeAll(async () => {
    api = await createTestApi({
      aliases: [{ token: TENANT_MFA_POLICY, existing: SettingsTenantMfaPolicy }],
    });
    settings = inMemoryTenantSettings(api);
    for (const definition of SETTING_DEFINITIONS) {
      settings.seed(A, definition.key, definition.defaultValue);
      settings.seed(B, definition.key, definition.defaultValue);
    }
    // O tenant B dispensa MFA; a política dele nunca vale para A.
    settings.seed(B, KEY, 'NONE', 2);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  };

  const versionOf = (tenantId: string) =>
    settings.snapshot().find((row) => row.tenantId === tenantId && row.key === KEY)?.version ?? 0;

  const createOrganization = (amr: readonly string[]) => {
    const cnpj = CNPJS[created % CNPJS.length] ?? '';
    created += 1;
    return request(api.server)
      .post('/api/v1/organizations')
      .set('Authorization', api.bearer(MARTA.subject, { amr }))
      .set('X-Tenant-Id', A)
      .send({
        name: `Órgão ${String(created)}`,
        shortName: `ORG${String(created)}`,
        cnpj,
        type: 'FUND',
      });
  };

  /** SET-02 pela própria API (com MFA, exigido pela política em vigor quando ela não é `NONE`). */
  const setPolicy = async (policy: string) => {
    const response = await request(api.server)
      .patch('/api/v1/settings')
      .set('Authorization', api.bearer(MARTA.subject, { amr: MFA }))
      .set('X-Tenant-Id', A)
      .send({ values: { [KEY]: policy }, expectedVersions: { [KEY]: versionOf(A) } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };

  it('[Sucesso] com NONE, ADMIN_ORGAO sem segundo fator (amr: ["pwd"]) cria órgão: 201', async () => {
    silence();
    await setPolicy('NONE');
    const response = await createOrganization(PWD);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('[Permissão negada] com ADMINS, a mesma chamada sem segundo fator responde 403 MFA_REQUIRED', async () => {
    silence();
    await setPolicy('ADMINS');
    expectProblem(await createOrganization(PWD), 403, 'MFA_REQUIRED');
  });

  it('[Sucesso] com ADMINS e amr com mfa/otp, 201', async () => {
    silence();
    expect((await createOrganization(['pwd', 'mfa'])).status).toBe(201);
    expect((await createOrganization(MFA)).status).toBe(201);
  });

  it('[Concorrência] alterar a configuração (SET-02) reflete na próxima requisição, sem reiniciar', async () => {
    silence();
    expectProblem(await createOrganization(PWD), 403, 'MFA_REQUIRED');
    await setPolicy('NONE');
    expect((await createOrganization(PWD)).status).toBe(201);
    await setPolicy('ADMINS');
    expectProblem(await createOrganization(PWD), 403, 'MFA_REQUIRED');
  });

  it('[Concorrência · US-090] política NONE → ALL com a sessão aberta: a próxima leitura exige MFA', async () => {
    silence();
    const listOrganizations = (amr: readonly string[]) =>
      request(api.server)
        .get('/api/v1/organizations')
        .set('Authorization', api.bearer(MARTA.subject, { amr }))
        .set('X-Tenant-Id', A);
    await setPolicy('NONE');
    expect((await listOrganizations(PWD)).status).toBe(200);
    await setPolicy('ALL');
    // RN-IAM-39: com ALL, toda requisição da instituição exige o segundo fator, não só as HIGH.
    expectProblem(await listOrganizations(PWD), 403, 'MFA_REQUIRED');
    expect((await listOrganizations(MFA)).status).toBe(200);
    await setPolicy('ADMINS');
    expect((await listOrganizations(PWD)).status).toBe(200);
  });

  it('[Tenant incorreto] a política NONE do tenant B não vale para o A', async () => {
    silence();
    expectProblem(await createOrganization(PWD), 403, 'MFA_REQUIRED');
  });
});
