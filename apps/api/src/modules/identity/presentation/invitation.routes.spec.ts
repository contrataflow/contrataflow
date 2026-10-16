import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  AcceptedInvitationDto,
  InvitationPreviewDto,
  TenantMembershipDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  roleAssignmentsOf,
  seedDefaultRolesOf,
  seedDepartment,
  seedOrganizations,
} from '../../../../test/support/structure-fixtures.js';
import {
  AUTHENTIK_DIRECTORY,
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  IDENTITY_TENANT_TRANSACTIONS,
} from '../application/ports.js';
import type { IdentityTenantTransactions } from '../application/ports.js';
import { hashInvitationToken } from '../domain/invitation.js';
import type {
  InMemoryAuthentikDirectory,
  InMemoryIdentityRepository,
} from '../infrastructure/in-memory-identity.repositories.js';

/*
 * US-091 — USR-01/03..06/14 pelo pipeline HTTP completo (autenticação, tenant, vínculo, MFA,
 * Idempotency-Key, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService` e o outbox em memória. O "e-mail" do convite é simulado por `deliverInvitation`
 * (o `EmailSender` do worker gera o token e grava só o hash). Os mesmos fluxos contra o PostgreSQL
 * (RLS, `cf_find_invitation`, transação única com Authentik) estão em
 * `test/tenant-leak/invitations.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** Ana do Gherkin: ADMIN_ORGAO da "Prefeitura de São José" (tenant A). */
const ANA = FAKE_USERS.marta;
/** Carla do Gherkin: só REQUISITANTE. */
const CARLA = FAKE_USERS.ana;
const MFA = ['pwd', 'otp'];
const DAY = 24 * 3_600_000;

const PMSJ = newId();
const COMPRAS = newId();
const SETOR_INATIVO = newId();
const ORG_B = newId();
const SETOR_B = newId();

let now = new Date('2026-10-15T12:00:00.000Z');

/** Transações simuladas com falha injetável (banco fora do ar). */
class ToggleTransactions implements IdentityTenantTransactions {
  failRead = false;
  failRun = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.failRun) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.failRead) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Convidar usuário e ativar vínculo (US-091)', () => {
  let api: TestApi;
  let identity: InMemoryIdentityRepository;
  let authentik: InMemoryAuthentikDirectory;
  const transactions = new ToggleTransactions();
  let roles: Map<string, { id: string }>;
  let rolesOfB: Map<string, { id: string }>;

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: IDENTITY_CLOCK, value: () => now },
        { token: IDENTITY_TENANT_TRANSACTIONS, value: transactions },
      ],
    });
    identity = api.app.get<InMemoryIdentityRepository>(IDENTITY_REPOSITORY, { strict: false });
    authentik = api.app.get<InMemoryAuthentikDirectory>(AUTHENTIK_DIRECTORY, { strict: false });
    // Background: "Prefeitura de São José" ativa, com o setor "Compras".
    seedOrganizations(
      api,
      { tenantId: A, id: PMSJ, shortName: 'PMSJ', cnpj: '11222333000181' },
      { tenantId: B, id: ORG_B, shortName: 'PMB', cnpj: '33000167000101' },
    );
    seedDepartment(api, { tenantId: A, id: COMPRAS, organizationId: PMSJ, name: 'Compras' });
    seedDepartment(api, {
      tenantId: A,
      id: SETOR_INATIVO,
      organizationId: PMSJ,
      name: 'Setor desativado',
      isActive: false,
    });
    seedDepartment(api, { tenantId: B, id: SETOR_B, organizationId: ORG_B, name: 'Setor de B' });
    roles = seedDefaultRolesOf(api, A);
    rolesOfB = seedDefaultRolesOf(api, B);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.failRead = false;
    transactions.failRun = false;
    authentik.unavailable = false;
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const asAdmin = (test: request.Test, user: { subject: string | null } = ANA, tenant = A) =>
    test
      .set('Authorization', api.bearer(user.subject ?? '', { amr: MFA }))
      .set('X-Tenant-Id', tenant);
  const invite = (body: Record<string, unknown>, user: { subject: string | null } = ANA) =>
    asAdmin(request(api.server).post('/api/v1/users/invitations'), user)
      .set('Idempotency-Key', newId())
      .send(body);
  const resend = (userId: string, tenant = A) =>
    asAdmin(request(api.server).post(`/api/v1/users/invitations/${userId}/resend`), ANA, tenant);
  const cancel = (userId: string) =>
    asAdmin(request(api.server).delete(`/api/v1/users/invitations/${userId}`));
  const listUsers = (query: string) => asAdmin(request(api.server).get(`/api/v1/users?${query}`));
  const asInvitee = (test: request.Test, subject: string, tenant?: string) => {
    const authed = test.set('Authorization', api.bearer(subject, { amr: ['pwd'] }));
    return tenant ? authed.set('X-Tenant-Id', tenant) : authed;
  };
  const accept = (token: string, subject: string, tenant?: string) =>
    asInvitee(request(api.server).post('/api/v1/invitations/accept'), subject, tenant).send({
      token,
    });
  const preview = (token: string, subject: string) =>
    asInvitee(request(api.server).post('/api/v1/invitations/preview'), subject).send({ token });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (eventType: string) => api.outboxRows().filter((r) => r.eventType === eventType);

  /** Convida um e-mail novo e devolve o vínculo criado (201 conferido). */
  async function invited(email: string, body: Record<string, unknown> = {}) {
    const response = await invite({ email, name: 'Pessoa Convidada', type: 'INTERNAL', ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dataOf<TenantMembershipDto>(response);
  }

  /** A pessoa define a senha no Authentik e entra: o `sub` é vinculado (primeiro login). */
  async function signIn(userId: string, subject: string) {
    await identity.recordLogin(userId, now, subject);
  }

  describe('[Sucesso] Convidar e aceitar o convite', () => {
    it('cria o vínculo INVITED (7 dias), UserInvited e auditoria; o aceite ativa e leva ao tenant', async () => {
      const compras = roles.get('COMPRAS');
      const invitesBefore = eventsOf('UserInvited').length;
      const response = await invite({
        email: ' Bruno@PMSJ.gov.br ',
        name: 'Bruno Alves',
        type: 'INTERNAL',
        jobTitle: 'Agente de compras',
        departmentIds: [COMPRAS],
        roleId: compras?.id,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const membership = dataOf<TenantMembershipDto>(response);
      expect(response.headers.location).toBe(`/api/v1/users/${membership.userId}`);
      expect(membership).toMatchObject({
        email: 'bruno@pmsj.gov.br',
        name: 'Bruno Alves',
        type: 'INTERNAL',
        status: 'INVITED',
        jobTitle: 'Agente de compras',
        expiresAt: null,
        departmentIds: [COMPRAS],
        primaryDepartmentId: COMPRAS,
        invitedAt: now.toISOString(),
        inviteExpiresAt: new Date(now.getTime() + 7 * DAY).toISOString(),
        activatedAt: null,
      });
      expect(JSON.stringify(response.body)).not.toMatch(/token|hash/i);

      // RN-IAM-46: conta provisionada no Authentik, sem senha, ligada ao User novo.
      const user = identity.userByEmail('bruno@pmsj.gov.br');
      expect(user?.authentikUserId).toBe(authentik.provisioned.at(-1)?.pk);
      expect(user?.subject).toBeNull();
      // RN-IAM-51: perfil inicial gravado já com o vínculo INVITED, no escopo padrão do perfil.
      expect(roleAssignmentsOf(api).at(-1)).toMatchObject({
        tenantId: A,
        membershipId: membership.id,
        roleId: compras?.id,
        scopeType: 'TENANT',
        grantedById: ANA.id,
      });
      expect(eventsOf('UserInvited')).toHaveLength(invitesBefore + 1);
      expect(eventsOf('UserInvited').at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'membership.invited',
        aggregateType: 'TenantMembership',
        aggregateId: membership.id,
        payload: {
          membershipId: membership.id,
          userId: membership.userId,
          type: 'INTERNAL',
          expiresAt: null,
          inviteExpiresAt: membership.inviteExpiresAt,
          resend: false,
        },
      });
      expect(auditOf('membership.invite').at(-1)).toMatchObject({
        tenantId: A,
        category: 'SECURITY',
        entityType: 'TenantMembership',
        entityId: membership.id,
        actorUserId: ANA.id,
        metadata: expect.objectContaining({
          type: 'INTERNAL',
          expiresAt: null,
          invitedById: ANA.id,
        }) as unknown,
      });
      // O vínculo ainda não dá acesso (DEC-134 · RN-IAM-51).
      await signIn(membership.userId, 'sub-bruno-pmsj');
      expectProblem(
        await asInvitee(request(api.server).get('/api/v1/me'), 'sub-bruno-pmsj', A),
        403,
        'MEMBERSHIP_INACTIVE',
      );

      // "Bruno define a senha no Authentik e abre o link do convite".
      const token = identity.deliverInvitation(membership.id);
      const shown = await preview(token, 'sub-bruno-pmsj');
      expect(shown.status, JSON.stringify(shown.body)).toBe(200);
      expect(dataOf<InvitationPreviewDto>(shown)).toEqual({
        tenant: { id: A, name: FAKE_TENANTS.prefeituraA.name },
        type: 'INTERNAL',
        jobTitle: 'Agente de compras',
        departments: [{ id: COMPRAS, name: 'Compras' }],
        expiresAt: null,
        inviteExpiresAt: membership.inviteExpiresAt,
      });

      const accepted = await accept(token, 'sub-bruno-pmsj');
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(dataOf<AcceptedInvitationDto>(accepted)).toMatchObject({
        id: membership.id,
        status: 'ACTIVE',
        activatedAt: now.toISOString(),
        inviteExpiresAt: null,
        tenant: { id: A, name: FAKE_TENANTS.prefeituraA.name },
      });
      expect(eventsOf('MembershipActivated').at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'membership.activated',
        payload: { membershipId: membership.id, userId: membership.userId },
      });
      expect(auditOf('membership.activate').at(-1)).toMatchObject({
        tenantId: A,
        category: 'SECURITY',
        entityId: membership.id,
        actorUserId: membership.userId,
        actorMembershipId: membership.id,
      });
      // Já na instituição que convidou: o vínculo ativo passa no pipeline.
      const me = await asInvitee(request(api.server).get('/api/v1/me'), 'sub-bruno-pmsj', A);
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      // Uso único: o mesmo link não ativa de novo.
      expectProblem(await accept(token, 'sub-bruno-pmsj'), 404, 'INVITATION_INVALID');
    });

    it('[FA-05] e-mail já vinculado a outra instituição: reaproveita o User, sem nova conta no Authentik', async () => {
      const heitor = FAKE_USERS.heitor;
      const provisioned = authentik.provisioned.length;
      const membership = await invited(heitor.email, { name: 'Heitor Barros' });
      expect(membership.userId).toBe(heitor.id);
      expect(authentik.provisioned).toHaveLength(provisioned);
      expect(identity.membershipOf(heitor.id, B)?.status).toBe('ACTIVE');
      expect(identity.membershipOf(heitor.id, A)?.status).toBe('INVITED');
    });

    it('USR-01 lista os convites pendentes (status=INVITED) e filtra por texto', async () => {
      const membership = await invited('lista@pmsj.gov.br', { name: 'Zuleica Pendente' });
      const response = await listUsers('status=INVITED&q=zuleica');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<TenantMembershipDto[]>(response)).toEqual([
        expect.objectContaining({
          id: membership.id,
          status: 'INVITED',
          email: 'lista@pmsj.gov.br',
        }),
      ]);
      const active = dataOf<TenantMembershipDto[]>(await listUsers('status=ACTIVE&pageSize=100'));
      expect(active.every((item) => item.status === 'ACTIVE')).toBe(true);
      expect(active.some((item) => item.userId === ANA.id)).toBe(true);
    });
  });

  describe('[Validação]', () => {
    it('vínculo externo sem validade → 422 VALIDATION_ERROR em expiresAt', async () => {
      const response = await invite({
        email: 'consultoria@externa.com.br',
        name: 'Consultoria Externa',
        type: 'EXTERNAL',
      });
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'expiresAt',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Informe a validade do vínculo externo.',
        }),
      ]);
    });

    it('validade além de security.externalMembershipMaxDays (180) → OUT_OF_RANGE', async () => {
      const response = await invite({
        email: 'consultoria@externa.com.br',
        name: 'Consultoria Externa',
        type: 'EXTERNAL',
        expiresAt: new Date(now.getTime() + 181 * DAY).toISOString(),
      });
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'expiresAt', code: 'OUT_OF_RANGE' }),
      ]);
    });

    it('vínculo externo válido grava expiresAt; perfil sem atribuição externa → NOT_ALLOWED', async () => {
      const expiresAt = new Date(now.getTime() + 90 * DAY).toISOString();
      const blocked = await invite({
        email: 'externo@consultoria.com.br',
        name: 'Consultor Externo',
        type: 'EXTERNAL',
        expiresAt,
        roleId: roles.get('ADMIN_ORGAO')?.id,
      });
      expect(expectProblem(blocked, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'roleId', code: 'NOT_ALLOWED' }),
      ]);
      const membership = await invited('externo@consultoria.com.br', {
        type: 'EXTERNAL',
        expiresAt,
        roleId: roles.get('CONSULTOR_EXTERNO')?.id,
      });
      expect(membership).toMatchObject({ type: 'EXTERNAL', expiresAt });
      expect(eventsOf('UserInvited').at(-1)?.payload).toMatchObject({
        type: 'EXTERNAL',
        expiresAt,
      });
    });

    it('e-mail inválido, unidade inativa/de outro tenant e perfil de outro tenant → 422', async () => {
      const badEmail = await invite({ email: 'nao-e-email', name: 'Fulano', type: 'INTERNAL' });
      expect(expectProblem(badEmail, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'email', message: 'Informe um e-mail válido.' }),
      ]);
      const inactive = await invite({
        email: 'fulano@pmsj.gov.br',
        name: 'Fulano',
        type: 'INTERNAL',
        departmentIds: [SETOR_INATIVO],
      });
      expect(expectProblem(inactive, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_INACTIVE' }),
      ]);
      const leak = await invite({
        email: 'fulano@pmsj.gov.br',
        name: 'Fulano',
        type: 'INTERNAL',
        departmentIds: [SETOR_B],
        roleId: rolesOfB.get('COMPRAS')?.id,
      });
      expect(expectProblem(leak, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_NOT_FOUND' }),
        expect.objectContaining({ field: 'roleId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(identity.userByEmail('fulano@pmsj.gov.br')).toBeUndefined();
    });

    it('token ausente ou malformado no aceite → 422 / 404 sem consulta', async () => {
      const missing = await asInvitee(
        request(api.server).post('/api/v1/invitations/accept'),
        ANA.subject,
      ).send({});
      expectProblem(missing, 422, 'VALIDATION_ERROR');
      expectProblem(await accept('curto', ANA.subject), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem USER_INVITE (REQUISITANTE) → 403 PERMISSION_DENIED, auditado como access.denied', async () => {
      const response = await invite(
        { email: 'outro@pmsj.gov.br', name: 'Outra Pessoa', type: 'INTERNAL' },
        CARLA,
      );
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        actorUserId: CARLA.id,
        reasonCode: 'USER_INVITE',
      });
      expectProblem(
        await asAdmin(request(api.server).get('/api/v1/users'), CARLA),
        403,
        'PERMISSION_DENIED',
      );
      expect(identity.userByEmail('outro@pmsj.gov.br')).toBeUndefined();
    });

    it('USER_INVITE é risco alto: sem segundo fator → 403 MFA_REQUIRED (POL-14)', async () => {
      const response = await request(api.server)
        .post('/api/v1/users/invitations')
        .set('Authorization', api.bearer(ANA.subject, { amr: ['pwd'] }))
        .set('X-Tenant-Id', A)
        .send({ email: 'outro@pmsj.gov.br', name: 'Outra Pessoa', type: 'INTERNAL' });
      expectProblem(response, 403, 'MFA_REQUIRED');
    });

    it('o convite é só do destinatário: outra pessoa autenticada → 404 INVITATION_INVALID', async () => {
      const membership = await invited('destinatario@pmsj.gov.br');
      await signIn(membership.userId, 'sub-destinatario');
      const token = identity.deliverInvitation(membership.id);
      expectProblem(await preview(token, CARLA.subject), 404, 'INVITATION_INVALID');
      expectProblem(await accept(token, CARLA.subject), 404, 'INVITATION_INVALID');
      expect(identity.membershipOf(membership.userId, A)?.status).toBe('INVITED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('aceitar convite da Prefeitura B com a A ativa ativa só o vínculo de B', async () => {
      const lucia = FAKE_USERS.lucia;
      const membershipId = newId();
      await runAsSystem({ name: 'Convite de teste', tenantId: B }, () =>
        identity.insertInvitation({} as TenantTx, {
          membershipId,
          tenantId: B,
          userId: lucia.id,
          type: 'INTERNAL',
          jobTitle: null,
          expiresAt: null,
          invitedById: null,
          now,
          inviteExpiresAt: new Date(now.getTime() + 7 * DAY),
        }),
      );
      const token = identity.deliverInvitation(membershipId);
      const activeInA = identity.membershipOf(lucia.id, A);

      const accepted = await accept(token, lucia.subject, A);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(dataOf<AcceptedInvitationDto>(accepted).tenant.id).toBe(B);
      expect(identity.membershipOf(lucia.id, B)?.status).toBe('ACTIVE');
      expect(identity.membershipOf(lucia.id, A)).toEqual(activeInA);
      expect(auditOf('membership.activate').at(-1)).toMatchObject({
        tenantId: B,
        entityId: membershipId,
      });
      expect(eventsOf('MembershipActivated').at(-1)).toMatchObject({ tenantId: B });
    });

    it('reenviar/cancelar convite pendente de outro tenant → 404 USER_NOT_FOUND, sem efeito', async () => {
      const userId = newId();
      const membershipId = newId();
      await runAsSystem({ name: 'Convite de teste', tenantId: B }, async () => {
        await identity.insertUser({} as TenantTx, {
          id: userId,
          email: 'so.de.b@prefeitura-b.test',
          name: 'Só de B',
          authentikUserId: null,
        });
        await identity.insertInvitation({} as TenantTx, {
          membershipId,
          tenantId: B,
          userId,
          type: 'INTERNAL',
          jobTitle: null,
          expiresAt: null,
          invitedById: null,
          now: new Date(now.getTime() - 2 * DAY),
          inviteExpiresAt: new Date(now.getTime() + 5 * DAY),
        });
      });
      const before = identity.membershipOf(userId, B);
      expectProblem(await resend(userId), 404, 'USER_NOT_FOUND');
      expectProblem(await cancel(userId), 404, 'USER_NOT_FOUND');
      expect(identity.membershipOf(userId, B)).toEqual(before);
      const listed = dataOf<TenantMembershipDto[]>(await listUsers('pageSize=100'));
      expect(listed.some((item) => item.userId === userId)).toBe(false);
      expect(
        listed.some((item) => item.userId === FAKE_USERS.heitor.id && item.status === 'ACTIVE'),
      ).toBe(false);
    });
  });

  describe('[Duplicidade]', () => {
    it('convite repetido para o mesmo e-mail → 409 MEMBERSHIP_ALREADY_EXISTS', async () => {
      await invited('repetido@pmsj.gov.br');
      const events = api.outboxRows().length;
      const provisioned = authentik.provisioned.length;
      const again = await invite({
        email: 'repetido@pmsj.gov.br',
        name: 'Outro Nome',
        type: 'INTERNAL',
      });
      expectProblem(again, 409, 'MEMBERSHIP_ALREADY_EXISTS');
      expect(api.outboxRows()).toHaveLength(events);
      expect(authentik.provisioned).toHaveLength(provisioned);
    });

    it('pessoa com vínculo ativo ou suspenso → 409', async () => {
      const active = await invite({
        email: FAKE_USERS.fabio.email,
        name: 'Fábio',
        type: 'INTERNAL',
      });
      expectProblem(active, 409, 'MEMBERSHIP_ALREADY_EXISTS');
      const suspended = await invite({
        email: FAKE_USERS.bruno.email,
        name: 'Bruno',
        type: 'INTERNAL',
      });
      expectProblem(suspended, 409, 'MEMBERSHIP_ALREADY_EXISTS');
    });

    it('[FA-02] cancelar: 204, o link deixa de valer e um novo convite reaproveita o vínculo', async () => {
      const membership = await invited('cancelado@pmsj.gov.br');
      await signIn(membership.userId, 'sub-cancelado');
      const token = identity.deliverInvitation(membership.id);
      const cancelled = await cancel(membership.userId);
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(204);
      expect(auditOf('membership.revoke').at(-1)).toMatchObject({
        entityId: membership.id,
        metadata: expect.objectContaining({ reason: 'INVITATION_CANCELLED' }) as unknown,
      });
      expectProblem(await accept(token, 'sub-cancelado'), 404, 'INVITATION_INVALID');
      expectProblem(await cancel(membership.userId), 409, 'INVALID_STATE');
      expectProblem(await resend(membership.userId), 404, 'USER_NOT_FOUND');

      const again = await invited('cancelado@pmsj.gov.br');
      expect(again).toMatchObject({ id: membership.id, status: 'INVITED' });
      expect(auditOf('membership.invite').at(-1)?.metadata).toMatchObject({ reinvite: true });
    });
  });

  describe('[FA-01] Reenvio', () => {
    it('gera nova validade, invalida o link anterior; limite de 1 min e de 5 reenvios (429)', async () => {
      const start = now;
      const membership = await invited('reenvio@pmsj.gov.br');
      await signIn(membership.userId, 'sub-reenvio');
      const oldToken = identity.deliverInvitation(membership.id);

      const tooSoon = await resend(membership.userId);
      expectProblem(tooSoon, 429, 'RATE_LIMITED');
      expect(tooSoon.headers['retry-after']).toBe('60');

      try {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          now = new Date(now.getTime() + 61_000);
          const response = await resend(membership.userId);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(dataOf<{ inviteExpiresAt: string }>(response).inviteExpiresAt).toBe(
            new Date(now.getTime() + 7 * DAY).toISOString(),
          );
        }
        expect(eventsOf('UserInvited').at(-1)?.payload).toMatchObject({
          membershipId: membership.id,
          resend: true,
        });
        expect(auditOf('membership.invite').at(-1)?.metadata).toMatchObject({
          resend: true,
          resendCount: 5,
        });
        expectProblem(await accept(oldToken, 'sub-reenvio'), 404, 'INVITATION_INVALID');

        now = new Date(now.getTime() + 61_000);
        const limit = await resend(membership.userId);
        expect(expectProblem(limit, 429, 'RATE_LIMITED').detail).toMatch(/5 vezes/);

        const fresh = identity.deliverInvitation(membership.id);
        expect((await accept(fresh, 'sub-reenvio')).status).toBe(200);
        expectProblem(await resend(membership.userId), 404, 'USER_NOT_FOUND');
      } finally {
        now = start;
      }
    });

    it('[FA-03] convite expirado → 410 INVITATION_EXPIRED na consulta e no aceite', async () => {
      const membership = await invited('expirado@pmsj.gov.br');
      await signIn(membership.userId, 'sub-expirado');
      const token = identity.deliverInvitation(membership.id);
      identity.setInviteExpiry(membership.id, new Date(now.getTime() - 1));
      expectProblem(await preview(token, 'sub-expirado'), 410, 'INVITATION_EXPIRED');
      const body = expectProblem(await accept(token, 'sub-expirado'), 410, 'INVITATION_EXPIRED');
      expect(body.detail).toBe('Este convite expirou. Peça para reenviarem.');
      expect(identity.membershipOf(membership.userId, A)?.status).toBe('INVITED');
    });

    it('[FA-04] token sem correspondência → 404 INVITATION_INVALID ("Este convite não é válido.")', async () => {
      const body = expectProblem(
        await accept('A'.repeat(43), ANA.subject),
        404,
        'INVITATION_INVALID',
      );
      expect(body.detail).toBe('Este convite não é válido.');
    });
  });

  describe('[Concorrência]', () => {
    it('reenvio no mesmo instante do aceite com o token original: só um vence', async () => {
      const start = now;
      const membership = await invited('corrida@pmsj.gov.br');
      await signIn(membership.userId, 'sub-corrida');
      const token = identity.deliverInvitation(membership.id);
      now = new Date(now.getTime() + 61_000);
      try {
        const [accepted, resent] = await Promise.all([
          accept(token, 'sub-corrida'),
          resend(membership.userId),
        ]);
        const status = identity.membershipOf(membership.userId, A)?.status;
        if (accepted.status === 200) {
          expect(status).toBe('ACTIVE');
          expectProblem(resent, 404, 'USER_NOT_FOUND');
        } else {
          expect(resent.status).toBe(200);
          expect(['INVITATION_INVALID', 'INVITATION_EXPIRED']).toContain(
            problemDetailsSchema.parse(accepted.body).code,
          );
          expect(status).toBe('INVITED');
        }
        expect(
          eventsOf('MembershipActivated').filter((e) => e.aggregateId === membership.id).length,
        ).toBeLessThanOrEqual(1);
      } finally {
        now = start;
      }
    });

    it('dois aceites simultâneos do mesmo token: um ativa, o outro recebe INVITATION_INVALID', async () => {
      const membership = await invited('duplo@pmsj.gov.br');
      await signIn(membership.userId, 'sub-duplo');
      const token = identity.deliverInvitation(membership.id);
      const results = await Promise.all([accept(token, 'sub-duplo'), accept(token, 'sub-duplo')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
      expect(
        eventsOf('MembershipActivated').filter((e) => e.aggregateId === membership.id),
      ).toHaveLength(1);
      expect(identity.membershipOf(membership.userId, A)?.inviteTokenHash).toBeNull();
      expect(hashInvitationToken(token)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('[Falha de banco]', () => {
    it('PostgreSQL indisponível → 503 DEPENDENCY_UNAVAILABLE; nada criado, Authentik nem chamado', async () => {
      silence();
      transactions.failRead = true;
      const events = api.outboxRows().length;
      const provisioned = authentik.provisioned.length;
      const response = await invite({
        email: 'bruno.db@pmsj.gov.br',
        name: 'Bruno',
        type: 'INTERNAL',
      });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(identity.userByEmail('bruno.db@pmsj.gov.br')).toBeUndefined();
      expect(api.outboxRows()).toHaveLength(events);
      expect(authentik.provisioned).toHaveLength(provisioned);
    });

    it('banco cai depois do Authentik: a conta criada agora é removida (compensação)', async () => {
      silence();
      transactions.failRun = true;
      const response = await invite({
        email: 'bruno.comp@pmsj.gov.br',
        name: 'Bruno',
        type: 'INTERNAL',
      });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      const created = authentik.provisioned.find((item) => item.email === 'bruno.comp@pmsj.gov.br');
      expect(created).toBeDefined();
      expect(authentik.removed).toContain(created?.pk);
      expect(identity.userByEmail('bruno.comp@pmsj.gov.br')).toBeUndefined();
    });
  });

  describe('[Falha de integração]', () => {
    it('Authentik fora do ar → 503 DEPENDENCY_UNAVAILABLE e nenhum vínculo sem a conta', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      authentik.unavailable = true;
      const events = api.outboxRows().length;
      const response = await invite({
        email: 'sem.conta@pmsj.gov.br',
        name: 'Sem Conta',
        type: 'INTERNAL',
      });
      const body = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(body.detail).toBe(
        'Não foi possível enviar o convite agora. Tente novamente em instantes.',
      );
      expect(identity.userByEmail('sem.conta@pmsj.gov.br')).toBeUndefined();
      expect(api.outboxRows()).toHaveLength(events);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'identity.authentik_provision_failed' }),
        'identity.authentik_provision_failed',
      );
    });
  });

  describe('Logs', () => {
    it('invitation_sent com e-mail mascarado; token e e-mail completo nunca aparecem', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const membership = await invited('mascarado@pmsj.gov.br');
      await signIn(membership.userId, 'sub-mascarado');
      const token = identity.deliverInvitation(membership.id);
      expect((await accept(token, 'sub-mascarado')).status).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'identity.invitation_sent', email: 'm***@pmsj.gov.br' }),
        'identity.invitation_sent',
      );
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'identity.invitation_accepted',
          membershipId: membership.id,
        }),
        'identity.invitation_accepted',
      );
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(hashInvitationToken(token));
      expect(logged).not.toContain('mascarado@pmsj.gov.br');
    });
  });
});
