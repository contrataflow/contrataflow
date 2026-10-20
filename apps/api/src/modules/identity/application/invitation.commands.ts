import type { PermissionCode } from '@contrataflow/types';
import { INVITE_SELECT_MESSAGE, MembershipActivated, UserInvited } from '@contrataflow/validation';
import type {
  AcceptedInvitationDto,
  FieldError,
  InvitationPreviewDto,
  InvitationResentDto,
  InviteUser,
  MembershipListQuery,
  TenantMembershipDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import { requireRequestContext, runWithTenantScope } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  AUTHENTIK_PROVISIONING,
  AuthentikUnavailableError,
  INVITATION_REPOSITORY,
  MEMBERSHIP_SETTINGS,
  MembershipTakenError,
  UserEmailTakenError,
} from './invitation-ports.js';
import type {
  AuthentikProvisioningPort,
  InvitationDraft,
  InvitationRepository,
  InviteeUser,
  MembershipSettingsPort,
  MembershipView,
} from './invitation-ports.js';
import { toMembershipDto } from './invitation.view.js';
import { IDENTITY_CLOCK, IDENTITY_TENANT_TRANSACTIONS, TENANT_MFA_POLICY } from './ports.js';
import type { Clock, IdentityTenantTransactions, TenantMfaPolicyPort } from './ports.js';
import {
  acceptDecision,
  blocksNewInvitation,
  externalValidityError,
  hashInvitationToken,
  inviteExpiryFrom,
  isWellFormedInvitationToken,
  resendDecision,
} from '../domain/invitation.js';
import type { PendingInvitation } from '../domain/invitation.js';
import { maskEmail } from '../domain/user.js';

/** Mensagem da story para o Authentik fora do ar (Casos de erro). */
const AUTHENTIK_UNAVAILABLE_DETAIL =
  'Não foi possível enviar o convite agora. Tente novamente em instantes.';

export function tenantOf(): string {
  const { tenantId } = requireRequestContext();
  if (tenantId === null) throw new Error('Caso de uso de vínculo exige o tenant do contexto.');
  return tenantId;
}

function membershipExists(): ApiError {
  return new ApiError('MEMBERSHIP_ALREADY_EXISTS');
}

function userNotFound(): ApiError {
  return new ApiError('USER_NOT_FOUND');
}

/**
 * Base dos casos de uso administrativos de vínculo: autoriza pela porta do `access`
 * (`MembershipReferences.assertCan` — permissão e, para risco alto, MFA conforme
 * `security.mfaPolicy`, POL-14) e lê o relógio.
 */
export abstract class MembershipCommand {
  protected readonly logger = new Logger('Identity');

  constructor(
    protected readonly references: MembershipReferences,
    protected readonly mfaPolicies: TenantMfaPolicyPort,
    protected readonly clock: Clock,
  ) {}

  protected async authorize(permission: PermissionCode): Promise<void> {
    const mfaPolicy = await this.mfaPolicies.mfaPolicyOf(tenantOf());
    this.references.assertCan(permission, { mfaPolicy });
  }
}

/** Referências do convite (V-04): unidades e perfil ativos do tenant; validade do `EXTERNAL`. */
async function referenceErrors(
  tx: TenantTx,
  body: InviteUser,
  now: Date,
  references: MembershipReferences,
  settings: MembershipSettingsPort,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (body.expiresAt) {
    const maxDays = await settings.externalMembershipMaxDays(tx);
    const error = externalValidityError(new Date(body.expiresAt), now, maxDays);
    if (error) errors.push(error);
  }
  const departmentIds = body.departmentIds ?? [];
  const departments = await references.departmentsByIds(tx, departmentIds);
  for (const id of departmentIds) {
    const department = departments.get(id);
    if (!department?.isActive) {
      errors.push({
        field: 'departmentIds',
        code: department ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
        message: INVITE_SELECT_MESSAGE,
      });
      break;
    }
  }
  if (body.roleId) {
    const role = await references.roleById(tx, body.roleId);
    if (!role?.isActive) {
      errors.push({
        field: 'roleId',
        code: role ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
        message: INVITE_SELECT_MESSAGE,
      });
    } else if (body.type === 'EXTERNAL' && !role.allowExternalAssignment) {
      // POL-15: perfil sem atribuição externa não vai para consultoria/órgão externo.
      errors.push({
        field: 'roleId',
        code: 'NOT_ALLOWED',
        message: 'Este perfil não pode ser atribuído a vínculo externo.',
      });
    }
  }
  return errors;
}

/** A pessoa ainda não tem conta no Authentik (sem PK e sem `sub` vinculado). */
function needsAuthentikAccount(user: InviteeUser | null): boolean {
  return user === null || (user.authentikUserId === null && user.externalSubject === null);
}

/**
 * `InviteUserCommand` — USR-03 (US-091 · fluxo principal, passos 3–4 · RN-IAM-46..52):
 * 1. `USER_INVITE` (+ MFA); referências e validade conferidas numa leitura do tenant (V-02/V-04);
 * 2. sem conta no Authentik, provisiona ANTES da transação (sem senha — DEC-130); Authentik fora →
 *    503 sem nada gravado;
 * 3. numa transação: `User` reaproveitado pelo e-mail ou criado, `TenantMembership` `INVITED`
 *    (novo, ou o `REVOKED`/`EXPIRED` reaproveitado), lotação, perfil inicial, `membership.invite`
 *    e `UserInvited` no outbox — que o worker transforma no e-mail do convite (fila `email`, com o
 *    link gerado no envio — queues.md §4.3). Banco falha depois do Authentik → a conta criada
 *    agora é removida (compensação).
 */
@Injectable()
export class InviteUserCommand extends MembershipCommand {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(AUTHENTIK_PROVISIONING) private readonly authentik: AuthentikProvisioningPort,
    @Inject(MEMBERSHIP_SETTINGS) private readonly settings: MembershipSettingsPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super(references, mfaPolicies, clock);
  }

  async execute(input: { readonly body: InviteUser }): Promise<TenantMembershipDto> {
    await this.authorize('USER_INVITE');
    const startedAt = performance.now();
    const context = requireRequestContext();
    const { body } = input;
    const now = this.clock();

    const existingUser = await this.transactions.read(async (tx) => {
      const errors = await referenceErrors(tx, body, now, this.references, this.settings);
      if (errors.length > 0) throw validationError(errors);
      const user = await this.invitations.findUserByEmail(tx, body.email);
      if (user) {
        const membership = await this.invitations.findMembershipByUser(tx, user.id);
        if (membership && blocksNewInvitation(membership.status)) throw membershipExists();
      }
      return user;
    });

    const account = needsAuthentikAccount(existingUser)
      ? await this.provision(body.email, body.name)
      : null;

    let view: MembershipView;
    try {
      view = await this.transactions.run((tx) => this.persist(tx, body, now, account?.pk ?? null));
    } catch (error) {
      if (account?.created) await this.authentik.removeUser(account.pk);
      if (error instanceof MembershipTakenError) throw membershipExists();
      // Outro convite criou o mesmo `User` no meio do caminho: a pessoa tente de novo.
      if (error instanceof UserEmailTakenError) throw new ApiError('CONFLICT');
      throw error;
    }

    this.logger.log(
      {
        event: 'identity.invitation_sent',
        membershipId: view.id,
        email: maskEmail(view.email),
        durationMs: Math.round(performance.now() - startedAt),
        tenantId: view.tenantId,
        correlationId: context.correlationId,
      },
      'identity.invitation_sent',
    );
    return toMembershipDto(view);
  }

  private async provision(email: string, name: string) {
    try {
      return await this.authentik.provisionUser({ email, name });
    } catch (error) {
      if (!(error instanceof AuthentikUnavailableError)) throw error;
      this.logger.warn(
        {
          event: 'identity.authentik_provision_failed',
          errorName: error.cause instanceof Error ? error.cause.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'identity.authentik_provision_failed',
      );
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        detail: AUTHENTIK_UNAVAILABLE_DETAIL,
        headers: { 'Retry-After': '30' },
        cause: error,
      });
    }
  }

  private async persist(
    tx: TenantTx,
    body: InviteUser,
    now: Date,
    authentikUserId: string | null,
  ): Promise<MembershipView> {
    const context = requireRequestContext();
    const tenantId = tenantOf();
    const actorId = context.actor.userId;

    // Relido na transação: o convite concorrente do mesmo e-mail (em qualquer tenant) já pode
    // ter criado o `User`.
    const current = await this.invitations.findUserByEmail(tx, body.email);
    let userId: string;
    if (current) {
      userId = current.id;
      if (authentikUserId !== null && current.authentikUserId === null) {
        await this.invitations.setAuthentikUserId(tx, current.id, authentikUserId);
      }
    } else {
      userId = newId();
      await this.invitations.insertUser(tx, {
        id: userId,
        email: body.email,
        name: body.name,
        authentikUserId,
        now,
      });
    }

    const existing = await this.invitations.findMembershipByUser(tx, userId);
    if (existing && blocksNewInvitation(existing.status)) throw membershipExists();
    const draft: InvitationDraft = {
      membershipId: existing?.id ?? newId(),
      tenantId,
      userId,
      type: body.type,
      jobTitle: body.jobTitle ?? null,
      expiresAt: body.type === 'EXTERNAL' && body.expiresAt ? new Date(body.expiresAt) : null,
      invitedById: actorId,
      now,
      inviteExpiresAt: inviteExpiryFrom(now),
    };
    if (existing) {
      if (!(await this.invitations.reinvite(tx, draft))) throw membershipExists();
    } else {
      await this.invitations.insertInvitation(tx, draft);
    }

    const departmentIds = body.departmentIds ?? [];
    await this.invitations.replaceDepartments(tx, {
      tenantId,
      membershipId: draft.membershipId,
      departmentIds,
      createdById: actorId,
      ids: departmentIds.map(() => newId()),
      now,
    });
    if (body.roleId && actorId !== null) {
      await this.references.grantInitialRole(tx, {
        id: newId(),
        tenantId,
        membershipId: draft.membershipId,
        roleId: body.roleId,
        grantedById: actorId,
        now,
      });
    }

    await this.audit.record(tx, {
      action: 'membership.invite',
      entityType: 'TenantMembership',
      entityId: draft.membershipId,
      metadata: {
        type: draft.type,
        expiresAt: draft.expiresAt?.toISOString() ?? null,
        invitedById: actorId,
        departmentIds,
        roleId: body.roleId ?? null,
        inviteExpiresAt: draft.inviteExpiresAt.toISOString(),
        reinvite: existing !== null,
      },
    });
    await this.outbox.record(
      tx,
      UserInvited.of({
        aggregateId: draft.membershipId,
        payload: {
          membershipId: draft.membershipId,
          userId,
          type: draft.type,
          expiresAt: draft.expiresAt?.toISOString() ?? null,
          inviteExpiresAt: draft.inviteExpiresAt.toISOString(),
          resend: false,
        },
      }),
    );
    const view = await this.invitations.membershipView(tx, draft.membershipId);
    if (!view) throw new Error('Vínculo recém-gravado não encontrado.');
    return view;
  }
}

/**
 * `ResendInvitationCommand` — USR-04 (FA-01 · RN-IAM-48/53): só em `INVITED`, até 5 reenvios com
 * 1 minuto entre eles (429 `RATE_LIMITED`). Nova validade de 7 dias e hash zerado na mesma
 * transação — o link anterior deixa de valer no commit —, `membership.invite` (`resend`) e
 * `UserInvited` (`resend = true`) para o worker reenviar o e-mail com um link novo.
 */
@Injectable()
export class ResendInvitationCommand extends MembershipCommand {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super(references, mfaPolicies, clock);
  }

  async execute(input: { readonly userId: string }): Promise<InvitationResentDto> {
    await this.authorize('USER_INVITE');
    const now = this.clock();
    const context = requireRequestContext();
    const inviteExpiresAt = await this.transactions.run(async (tx) => {
      const membership = await this.invitations.findMembershipByUser(tx, input.userId);
      if (!membership) throw userNotFound();
      const decision = resendDecision(
        {
          status: membership.status,
          invitedAt: membership.invitedAt,
          resendCount: membership.inviteResendCount,
        },
        now,
      );
      if (decision.kind === 'not_invited') throw userNotFound();
      if (decision.kind === 'limit_reached') {
        throw new ApiError('RATE_LIMITED', {
          detail: 'Este convite já foi reenviado 5 vezes. Cancele e convide novamente.',
        });
      }
      if (decision.kind === 'too_soon') {
        throw new ApiError('RATE_LIMITED', {
          detail: 'Aguarde um minuto antes de reenviar o convite.',
          headers: { 'Retry-After': String(decision.retryAfterSeconds) },
        });
      }
      const expiresAt = inviteExpiryFrom(now);
      const resendCount = membership.inviteResendCount + 1;
      const renewed = await this.invitations.renewInvitation(tx, {
        membershipId: membership.id,
        now,
        inviteExpiresAt: expiresAt,
        expectedResendCount: membership.inviteResendCount,
        resendCount,
        updatedById: context.actor.userId,
      });
      // Outro reenvio (ou o aceite) venceu a corrida: o mesmo efeito de chegar depois dele.
      if (!renewed) {
        throw new ApiError('RATE_LIMITED', {
          detail: 'Aguarde um minuto antes de reenviar o convite.',
          headers: { 'Retry-After': '60' },
        });
      }
      await this.audit.record(tx, {
        action: 'membership.invite',
        entityType: 'TenantMembership',
        entityId: membership.id,
        metadata: {
          type: membership.type,
          invitedById: context.actor.userId,
          inviteExpiresAt: expiresAt.toISOString(),
          resend: true,
          resendCount,
        },
      });
      await this.outbox.record(
        tx,
        UserInvited.of({
          aggregateId: membership.id,
          payload: {
            membershipId: membership.id,
            userId: membership.userId,
            type: membership.type === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
            inviteExpiresAt: expiresAt.toISOString(),
            resend: true,
          },
        }),
      );
      return expiresAt;
    });
    this.logger.log(
      {
        event: 'identity.invitation_resent',
        userId: input.userId,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'identity.invitation_resent',
    );
    return { inviteExpiresAt: inviteExpiresAt.toISOString() };
  }
}

/**
 * `CancelInvitationCommand` — USR-05 (FA-02 · RN-IAM-48): só em `INVITED` (senão 409
 * `INVALID_STATE`). O vínculo nunca chega a valer: vira `REVOKED` sem token (revogação lógica — a
 * aplicação não exclui vínculos), auditado como `membership.revoke` (`INVITATION_CANCELLED`). Um
 * convite novo para a mesma pessoa reaproveita o registro.
 */
@Injectable()
export class CancelInvitationCommand extends MembershipCommand {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {
    super(references, mfaPolicies, clock);
  }

  async execute(input: { readonly userId: string }): Promise<void> {
    await this.authorize('USER_INVITE');
    const now = this.clock();
    const context = requireRequestContext();
    const actorId = context.actor.userId;
    if (actorId === null) throw new ApiError('UNAUTHENTICATED');
    await this.transactions.run(async (tx) => {
      const membership = await this.invitations.findMembershipByUser(tx, input.userId);
      if (!membership) throw userNotFound();
      const cancelled =
        membership.status === 'INVITED' &&
        (await this.invitations.cancelInvitation(tx, {
          membershipId: membership.id,
          now,
          revokedById: actorId,
        }));
      if (!cancelled) throw new ApiError('INVALID_STATE');
      await this.audit.record(tx, {
        action: 'membership.revoke',
        entityType: 'TenantMembership',
        entityId: membership.id,
        changes: [{ path: 'status', old: 'INVITED', new: 'REVOKED' }],
        metadata: { reason: 'INVITATION_CANCELLED' },
      });
    });
    this.logger.log(
      {
        event: 'identity.invitation_cancelled',
        userId: input.userId,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'identity.invitation_cancelled',
    );
  }
}

/**
 * Convite do token para o usuário autenticado (USR-06/USR-14): malformado, inexistente, já
 * aceito, cancelado ou de outra pessoa → 404 `INVITATION_INVALID` sem dizer qual (RN-IAM-50);
 * validade vencida → 410 `INVITATION_EXPIRED`; instituição fora de `ACTIVE` → 403
 * `TENANT_SUSPENDED`.
 */
async function resolveInvitation(
  invitations: InvitationRepository,
  token: string,
  now: Date,
): Promise<{ readonly invitation: PendingInvitation; readonly tokenHash: string }> {
  const userId = requireRequestContext().actor.userId;
  if (userId === null || !isWellFormedInvitationToken(token)) {
    throw new ApiError('INVITATION_INVALID');
  }
  const tokenHash = hashInvitationToken(token);
  const invitation = await invitations.findInvitationByTokenHash(tokenHash);
  const decision = acceptDecision(invitation, userId, now);
  if (decision.kind === 'invalid' || !invitation) throw new ApiError('INVITATION_INVALID');
  if (decision.kind === 'expired') throw new ApiError('INVITATION_EXPIRED');
  if (decision.kind === 'tenant_unavailable') throw new ApiError('TENANT_SUSPENDED');
  return { invitation, tokenHash };
}

/** Contexto filho no tenant do convite (rota `CROSS_TENANT_LOOKUP` — o da sessão não muda). */
function inInvitationTenant<T>(invitation: PendingInvitation, work: () => Promise<T>): Promise<T> {
  const context = requireRequestContext();
  return runWithTenantScope(
    {
      tenantId: invitation.tenantId,
      userId: invitation.userId,
      membershipId: invitation.membershipId,
      actorName: context.actor.name ?? null,
    },
    work,
  );
}

/**
 * `AcceptInvitationCommand` — USR-06 (passos 6–7 · RN-IAM-49/50): confere o token do próprio
 * usuário e, no tenant DO CONVITE (nunca o ativo da sessão — Gherkin "Tenant incorreto"), ativa o
 * vínculo numa transação condicional ao hash e à validade: de um aceite e de um reenvio
 * simultâneos só um vence; o outro recebe `INVITATION_INVALID`/`INVITATION_EXPIRED`. Grava
 * `membership.activate` e `MembershipActivated`.
 */
@Injectable()
export class AcceptInvitationCommand {
  private readonly logger = new Logger('Identity');

  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async execute(input: { readonly token: string }): Promise<AcceptedInvitationDto> {
    const now = this.clock();
    const { invitation, tokenHash } = await resolveInvitation(this.invitations, input.token, now);
    const view = await inInvitationTenant(invitation, () =>
      this.transactions.run(async (tx) => {
        const activated = await this.invitations.activate(tx, {
          membershipId: invitation.membershipId,
          tokenHash,
          now,
          userId: invitation.userId,
        });
        if (!activated) {
          // Perdeu a corrida para um reenvio, um cancelamento ou o fim da validade.
          const current = await this.invitations.findMembershipByUser(tx, invitation.userId);
          const expired =
            current?.status === 'INVITED' &&
            current.inviteExpiresAt !== null &&
            current.inviteExpiresAt.getTime() <= now.getTime();
          throw new ApiError(expired ? 'INVITATION_EXPIRED' : 'INVITATION_INVALID');
        }
        await this.audit.record(tx, {
          action: 'membership.activate',
          entityType: 'TenantMembership',
          entityId: invitation.membershipId,
          changes: [{ path: 'status', old: 'INVITED', new: 'ACTIVE' }],
          metadata: { membershipId: invitation.membershipId },
        });
        await this.outbox.record(
          tx,
          MembershipActivated.of({
            aggregateId: invitation.membershipId,
            payload: { membershipId: invitation.membershipId, userId: invitation.userId },
          }),
        );
        const activatedView = await this.invitations.membershipView(tx, invitation.membershipId);
        if (!activatedView) throw new Error('Vínculo ativado não encontrado.');
        return activatedView;
      }),
    );
    this.logger.log(
      {
        event: 'identity.invitation_accepted',
        membershipId: view.id,
        tenantId: view.tenantId,
        correlationId: requireRequestContext().correlationId,
      },
      'identity.invitation_accepted',
    );
    return {
      ...toMembershipDto(view),
      tenant: { id: invitation.tenantId, name: invitation.tenantName },
    };
  }
}

/**
 * `PreviewInvitationQuery` — USR-14 (SCR-102, passo 6): instituição, tipo, cargo, lotação e
 * validades do convite do próprio usuário, antes da confirmação — com as mesmas recusas do aceite.
 */
@Injectable()
export class PreviewInvitationQuery {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    private readonly references: MembershipReferences,
  ) {}

  async execute(input: { readonly token: string }): Promise<InvitationPreviewDto> {
    const now = this.clock();
    const { invitation } = await resolveInvitation(this.invitations, input.token, now);
    return inInvitationTenant(invitation, () =>
      this.transactions.read(async (tx) => {
        const view = await this.invitations.membershipView(tx, invitation.membershipId);
        if (!view) throw new ApiError('INVITATION_INVALID');
        if (view.inviteExpiresAt === null) throw new ApiError('INVITATION_INVALID');
        const departments = await this.references.departmentsByIds(tx, view.departmentIds);
        return {
          tenant: { id: invitation.tenantId, name: invitation.tenantName },
          type: view.type === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
          jobTitle: view.jobTitle,
          departments: view.departmentIds.flatMap((id) => {
            const department = departments.get(id);
            return department ? [{ id, name: department.name }] : [];
          }),
          expiresAt: view.expiresAt?.toISOString() ?? null,
          inviteExpiresAt: view.inviteExpiresAt.toISOString(),
        };
      }),
    );
  }
}

/**
 * `ListMembershipsQuery` — USR-01 (`USER_VIEW`): vínculos do tenant com filtros `status` (lista =
 * OU), `type`, `q` (nome ou e-mail) e, desde a US-092, `departmentId` (lotação). Base da lista de
 * usuários e da de convites pendentes do SCR-029 (`status=INVITED`).
 */
@Injectable()
export class ListMembershipsQuery extends MembershipCommand {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
  ) {
    super(references, mfaPolicies, clock);
  }

  async execute(
    query: MembershipListQuery,
  ): Promise<{ readonly items: TenantMembershipDto[]; readonly totalItems: number }> {
    await this.authorize('USER_VIEW');
    const page = await this.transactions.read((tx) =>
      this.invitations.listTenantMemberships(tx, {
        q: query.q,
        statuses: query.status,
        type: query.type,
        departmentId: query.departmentId,
        offset: (query.page - 1) * query.pageSize,
        limit: query.pageSize,
      }),
    );
    return { items: page.items.map(toMembershipDto), totalItems: page.total };
  }
}
