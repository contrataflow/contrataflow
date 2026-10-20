import { NOTIFICATION_MAX_UNIT_RECIPIENTS } from '@contrataflow/types';
import type { DomainEventEnvelope, NotificationType, PermissionCode } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { NotificationPlan, RecipientLookup, RecipientSpec } from './notification-rules.js';

/*
 * Resolução de destinatários do `NotificationDispatcher` (events.md §6 · US-111), dentro da
 * `tenantTransaction` do job (RLS do tenant do evento). As fontes que dependem de tabelas de
 * outros módulos são PORTAS registradas pelas stories donas; sem a fonte, o destinatário não é
 * resolvido (falha fechada, log `notification.recipient_unresolved`) — nunca se notifica "todo
 * mundo" por falta de informação.
 */

type Payload = Readonly<Record<string, unknown>>;

/** Leituras de identidade/organização/tenancy já disponíveis no banco (SQL do worker). */
export interface NotificationDirectory {
  /** Dos `userIds`, os com vínculo `ACTIVE` não vencido no tenant e usuário ativo. */
  activeMembers(client: SqlClient, userIds: readonly string[], now: Date): Promise<Set<string>>;
  /** Membros ativos lotados na unidade, até `limit` (ordem estável por id). */
  departmentMembers(
    client: SqlClient,
    departmentId: string,
    limit: number,
    now: Date,
  ): Promise<string[]>;
  /** Titular e substituto da unidade ativa (`null` = inexistente ou inativa). */
  departmentHeads(
    client: SqlClient,
    departmentId: string,
  ): Promise<{ readonly headUserId: string | null; readonly deputyUserId: string | null } | null>;
  /**
   * Usuários com vínculo ativo cuja atribuição de perfil vigente concede a permissão, em qualquer
   * escopo, até `limit` (ordem estável por id — US-116).
   */
  tenantPermissionHolders(
    client: SqlClient,
    permission: PermissionCode,
    limit: number,
    now: Date,
  ): Promise<string[]>;
  /** Dono do vínculo. */
  membershipUser(client: SqlClient, membershipId: string): Promise<string | null>;
  /** `notifications.emailEnabled` do tenant (padrão do registro de configurações se ausente). */
  tenantEmailEnabled(client: SqlClient): Promise<boolean>;
}

/** Fonte de destinatários de um módulo dono (ex.: participantes do processo — US-012). */
export interface RecipientLookupSource {
  readonly lookup: RecipientLookup;
  resolve(client: SqlClient, event: DomainEventEnvelope<Payload>): Promise<readonly string[]>;
}

/** Quem tem a permissão sobre a unidade (atribuições com escopo — US-096). */
export interface PermissionHolders {
  filter(
    client: SqlClient,
    userIds: readonly string[],
    permission: PermissionCode,
    departmentId: string,
  ): Promise<string[]>;
}

/** Visibilidade do processo (DEC-024 · `ProcessAccess` — US-001/US-012). */
export interface ProcessVisibility {
  visibleTo(client: SqlClient, processId: string, userIds: readonly string[]): Promise<Set<string>>;
}

export interface RecipientResolverDeps {
  readonly directory: NotificationDirectory;
  readonly lookups?: readonly RecipientLookupSource[];
  readonly permissions?: PermissionHolders | null;
  readonly visibility?: ProcessVisibility | null;
}

export interface ResolvedRecipients {
  /** Destinatários finais, em ordem (a ordem das travas evita impasse entre jobs concorrentes). */
  readonly recipients: readonly string[];
  /** Motivos de destinatários não resolvidos (para o log; sem dados pessoais). */
  readonly unresolved: readonly string[];
}

/** Membros buscados antes do filtro de permissão (a unidade raramente passa disso). */
const PERMISSION_CANDIDATES = 1_000;

export class RecipientResolver {
  private readonly lookups: ReadonlyMap<RecipientLookup, RecipientLookupSource>;

  constructor(private readonly deps: RecipientResolverDeps) {
    this.lookups = new Map((deps.lookups ?? []).map((source) => [source.lookup, source]));
  }

  async resolve(
    client: SqlClient,
    plan: NotificationPlan,
    event: DomainEventEnvelope<Payload>,
    now: Date,
  ): Promise<ResolvedRecipients> {
    const unresolved: string[] = [];
    const candidates = new Set<string>();
    for (const spec of plan.recipients) {
      for (const userId of await this.resolveSpec(client, spec, event, now, unresolved)) {
        candidates.add(userId);
      }
    }
    // RN-NTF-02: o ator nunca é destinatário da própria notificação — salvo o aviso do trabalho
    // assíncrono que ele mesmo pediu (IA — events.md §6).
    if (event.actor.userId !== null && plan.includeActor !== true) {
      candidates.delete(event.actor.userId);
    }
    if (candidates.size === 0) return { recipients: [], unresolved };

    const active = await this.deps.directory.activeMembers(client, [...candidates], now);
    let recipients = [...candidates].filter((userId) => active.has(userId));
    // RN-NTF-06 · FA-03: só quem vê o processo AGORA; sem a fonte de visibilidade, ninguém.
    if (event.processId !== null && recipients.length > 0) {
      if (!this.deps.visibility) {
        return { recipients: [], unresolved: [...unresolved, 'VISIBILITY_UNAVAILABLE'] };
      }
      const visible = await this.deps.visibility.visibleTo(client, event.processId, recipients);
      recipients = recipients.filter((userId) => visible.has(userId));
    }
    return { recipients: recipients.sort(), unresolved };
  }

  private async resolveSpec(
    client: SqlClient,
    spec: RecipientSpec,
    event: DomainEventEnvelope<Payload>,
    now: Date,
    unresolved: string[],
  ): Promise<readonly string[]> {
    const { directory } = this.deps;
    switch (spec.kind) {
      case 'USER':
        return spec.userId === null ? [] : [spec.userId];
      case 'MEMBERSHIP_USER': {
        if (spec.membershipId === null) return [];
        const userId = await directory.membershipUser(client, spec.membershipId);
        return userId === null ? [] : [userId];
      }
      case 'DEPARTMENT_HEADS': {
        if (spec.departmentId === null) return [];
        const heads = await directory.departmentHeads(client, spec.departmentId);
        if (!heads) return [];
        return [heads.headUserId, spec.includeDeputy ? heads.deputyUserId : null].filter(
          (userId): userId is string => userId !== null,
        );
      }
      case 'DEPARTMENT_MEMBERS':
        return this.departmentMembers(client, spec, now, unresolved);
      case 'TENANT_PERMISSION_HOLDERS':
        return directory.tenantPermissionHolders(
          client,
          spec.permission,
          NOTIFICATION_MAX_UNIT_RECIPIENTS,
          now,
        );
      case 'LOOKUP': {
        const source = this.lookups.get(spec.lookup);
        if (!source) {
          unresolved.push(`LOOKUP_UNAVAILABLE:${spec.lookup}`);
          return [];
        }
        return source.resolve(client, event);
      }
      case 'FIRST_OF':
        for (const inner of spec.specs) {
          const found = await this.resolveSpec(client, inner, event, now, unresolved);
          if (found.length > 0) return found;
        }
        return [];
    }
  }

  /**
   * FA-01: cada membro ativo da unidade (com a permissão, quando o tipo pede), até 50; acima disso,
   * a unidade é avisada pelo titular e pelo substituto, como no fallback de `APPROVAL_REQUESTED`.
   */
  private async departmentMembers(
    client: SqlClient,
    spec: Extract<RecipientSpec, { kind: 'DEPARTMENT_MEMBERS' }>,
    now: Date,
    unresolved: string[],
  ): Promise<readonly string[]> {
    const { departmentId, permission } = spec;
    if (departmentId === null) return [];
    const { directory, permissions } = this.deps;
    let members: string[];
    if (permission === undefined) {
      members = await directory.departmentMembers(
        client,
        departmentId,
        NOTIFICATION_MAX_UNIT_RECIPIENTS + 1,
        now,
      );
    } else {
      if (!permissions) {
        unresolved.push(`PERMISSION_UNAVAILABLE:${permission}`);
        return [];
      }
      const all = await directory.departmentMembers(
        client,
        departmentId,
        PERMISSION_CANDIDATES,
        now,
      );
      members = await permissions.filter(client, all, permission, departmentId);
    }
    if (members.length <= NOTIFICATION_MAX_UNIT_RECIPIENTS) return members;
    const heads = await directory.departmentHeads(client, departmentId);
    return [heads?.headUserId ?? null, heads?.deputyUserId ?? null].filter(
      (userId): userId is string => userId !== null,
    );
  }
}

/** Preferências salvas de um destinatário para o tipo (US-113); campo ausente = padrão do registro. */
export interface RecipientPreference {
  readonly email?: boolean;
  readonly inApp?: boolean;
}

/** Preferências por destinatário (US-113); quem não consta segue o padrão do registro. */
export interface NotificationPreferences {
  preferences(
    client: SqlClient,
    type: NotificationType,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, RecipientPreference>>;
}

/** Sem preferências salvas (US-113): todos seguem o padrão do registro. */
export const REGISTRY_DEFAULT_PREFERENCES: NotificationPreferences = {
  preferences: () => Promise.resolve(new Map()),
};
