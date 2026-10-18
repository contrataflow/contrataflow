import { ProcessUpdated } from '@contrataflow/validation';
import type { CreateTag, ProcessTagsDto, TagDto, UpdateTag } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  PROCESS_CLOCK,
  PROCESS_REPOSITORY,
  PROCESS_TRANSACTIONS,
  TAG_REPOSITORY,
  TagNameTakenError,
} from './ports.js';
import type {
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
  TagRepository,
} from './ports.js';
import { ProcessItemsGate } from './process-items.support.js';
import type { GateRefusals } from './process-items.support.js';
import {
  processTagsNotCustodian,
  processTagsNotEditable,
  processTagsVersionConflict,
  tagNameTaken,
  tagNotFound,
} from './process.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  applyTagPatch,
  diffTagSets,
  newTag,
  tagSetErrors,
  tagUpdateAction,
} from '../domain/tag.js';
import type { Tag } from '../domain/tag.js';

/*
 * Etiquetas (US-007 · TAG-01..03 e PRC-18 · RN-PROC-85..92). O cadastro (TAG-02/03) exige
 * `TAG_MANAGE` e grava só auditoria de configuração (sem evento de domínio — RN-PROC-90); a
 * aplicação ao processo (PRC-18) é edição do agregado: `PROCESS_UPDATE` + custódia (POL-01) sob o
 * bloqueio do processo, com versão, `ProcessUpdated`, timeline e `process.tags_update` na mesma
 * transação (RN-PROC-87/89). Logs sem nomes de etiqueta nem dados do processo.
 */

const TAG_ENTITY = 'Tag';
const PROCESS_ENTITY = 'Process';

const TAG_REFUSALS: GateRefusals = {
  notEditable: processTagsNotEditable,
  notCustodian: processTagsNotCustodian,
};

export function toTagDto(tag: Tag): TagDto {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    isActive: tag.isActive,
    version: tag.version,
  };
}

function userIdOf(): string | null {
  return requireRequestContext().actor.userId;
}

/** TAG-01: etiquetas ativas (`PROCESS_VIEW`); `includeInactive` só é atendido com `TAG_MANAGE` (RN-PROC-91). */
@Injectable()
export class ListTagsQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    private readonly access: AccessFacade,
  ) {}

  async execute(includeInactive: boolean): Promise<TagDto[]> {
    const permissions = await this.access.effectivePermissions();
    const withInactive = includeInactive && permissions.has('TAG_MANAGE');
    return this.transactions.read(async (tx) =>
      (await this.tags.list(tx, withInactive)).map(toTagDto),
    );
  }
}

interface Prepared {
  readonly now: Date;
}

/** TAG-02 (`Idempotency-Key` no pipeline): cadastra a etiqueta e audita `tag.create`. */
@Injectable()
export class CreateTagCommand extends TransactionalCommandHandler<CreateTag, Prepared, TagDto> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {
    super('tag.create', transactions);
  }

  protected async prepare(): Promise<Prepared> {
    this.access.assertCan('TAG_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    return { now: this.clock() };
  }

  protected async handle(tx: TenantTx, input: CreateTag, { now }: Prepared): Promise<TagDto> {
    const { tenantId } = requireRequestContext();
    const tag = newTag({
      id: newId(),
      tenantId: tenantId ?? '',
      name: input.name,
      color: input.color,
      now,
      userId: userIdOf(),
    });
    try {
      await this.tags.insert(tx, tag);
    } catch (error) {
      if (error instanceof TagNameTakenError) throw tagNameTaken();
      throw error;
    }
    await this.audit.record(tx, {
      action: 'tag.create',
      entityType: TAG_ENTITY,
      entityId: tag.id,
      changes: [
        { path: 'name', old: null, new: tag.name },
        { path: 'color', old: null, new: tag.color },
      ],
      metadata: { tagId: tag.id },
    });
    return toTagDto(tag);
  }

  protected override committed(result: TagDto): void {
    const { tenantId, correlationId } = requireRequestContext();
    this.logger.log(
      {
        event: 'tag.created',
        tagId: result.id,
        isActive: result.isActive,
        tenantId,
        correlationId,
      },
      'tag.created',
    );
  }
}

export interface UpdateTagInput {
  readonly id: string;
  readonly patch: UpdateTag;
  /** `If-Match` (a versão que a tela leu; o 428 é do guard). */
  readonly expectedVersion: number;
}

export interface UpdatedTag {
  readonly dto: TagDto;
  readonly changed: boolean;
}

/**
 * TAG-03 (`If-Match` obrigatório no pipeline): renomeia, recolore, desativa ou reativa. Reflete em
 * todos os processos (associação por id) sem tocar a versão deles nem gerar evento (RN-PROC-90);
 * PATCH sem diferença = a etiqueta atual, sem versão nem auditoria.
 */
@Injectable()
export class UpdateTagCommand extends TransactionalCommandHandler<
  UpdateTagInput,
  Prepared,
  UpdatedTag
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {
    super('tag.update', transactions);
  }

  protected async prepare(): Promise<Prepared> {
    this.access.assertCan('TAG_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    return { now: this.clock() };
  }

  protected async handle(
    tx: TenantTx,
    input: UpdateTagInput,
    { now }: Prepared,
  ): Promise<UpdatedTag> {
    const current = await this.tags.findById(tx, input.id);
    if (current === null) throw tagNotFound();
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError({
        aggregateType: TAG_ENTITY,
        aggregateId: current.id,
        expectedVersion: input.expectedVersion,
      });
    }
    const { tag, changes } = applyTagPatch(current, input.patch, { now, userId: userIdOf() });
    if (changes.length === 0) return { dto: toTagDto(current), changed: false };
    try {
      await this.tags.update(tx, tag, input.expectedVersion);
    } catch (error) {
      if (error instanceof TagNameTakenError) throw tagNameTaken();
      throw error;
    }
    await this.audit.record(tx, {
      action: tagUpdateAction(changes),
      entityType: TAG_ENTITY,
      entityId: tag.id,
      changes: changes.map((change) => ({ path: change.path, old: change.old, new: change.new })),
      metadata: { tagId: tag.id },
    });
    return { dto: toTagDto({ ...tag, version: current.version + 1 }), changed: true };
  }

  protected override committed(result: UpdatedTag): void {
    if (!result.changed) return;
    const { tenantId, correlationId } = requireRequestContext();
    this.logger.log(
      {
        event: 'tag.updated',
        tagId: result.dto.id,
        isActive: result.dto.isActive,
        tenantId,
        correlationId,
      },
      'tag.updated',
    );
  }
}

export interface SetProcessTagsInput {
  readonly processId: string;
  readonly tagIds: readonly string[];
  /** `If-Match` com a versão do PROCESSO (o `ETag` que o cabeçalho leu — RN-PROC-87). */
  readonly expectedVersion: number;
}

export interface SetProcessTagsResult {
  readonly data: ProcessTagsDto;
  /** Versão do processo depois da operação (o `ETag` da resposta). */
  readonly processVersion: number;
  readonly processId: string;
  readonly added: number;
  readonly removed: number;
  /** Conjunto idêntico (RN-PROC-89): sem versão, evento, timeline nem auditoria. */
  readonly noop: boolean;
}

const byName = (a: Tag, b: Tag) =>
  a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);

/**
 * PRC-18 — `SetProcessTagsCommand` (fluxo principal, passos 4–6): trava o processo, autoriza
 * (`PROCESS_UPDATE` cobrindo o processo → status editável → custódia), valida o conjunto
 * (RN-PROC-88), calcula a diferença e, havendo mudança e `If-Match` igual à versão, grava só as
 * inserções/remoções de `process_tags`, incrementa a versão do processo, `process.tags_update` e
 * `ProcessUpdated` (`changedFields = ["tags"]` → timeline `PROCESS_UPDATED`) — RN-PROC-89.
 */
@Injectable()
export class SetProcessTagsCommand extends TransactionalCommandHandler<
  SetProcessTagsInput,
  Prepared,
  SetProcessTagsResult
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly gate: ProcessItemsGate,
  ) {
    super('process.tags_change', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: SetProcessTagsInput,
    { now }: Prepared,
  ): Promise<SetProcessTagsResult> {
    const context = await this.gate.writable(tx, input.processId, TAG_REFUSALS);
    const { process } = context.rows;
    const applied = (await this.tags.forProcesses(tx, [process.id])).get(process.id) ?? [];
    const appliedIds = new Set(applied.map((tag) => tag.id));

    const known = await this.tags.findByIds(tx, input.tagIds);
    const errors = tagSetErrors(input.tagIds, known, appliedIds);
    if (errors.length > 0) throw validationError(errors);

    const diff = diffTagSets(
      applied.map((tag) => tag.id),
      input.tagIds,
    );
    if (diff.added.length === 0 && diff.removed.length === 0) {
      return {
        data: { tags: applied.map(toTagDto) },
        processVersion: process.version,
        processId: process.id,
        added: 0,
        removed: 0,
        noop: true,
      };
    }
    if (input.expectedVersion !== process.version) {
      throw processTagsVersionConflict(input.expectedVersion, process.version);
    }

    const userId = userIdOf();
    await this.tags.applyDiff(tx, process.id, diff, now, userId);
    const processVersion = await this.processes.touchProcess(tx, process.id, now, userId ?? '');

    const next = known.slice().sort(byName);
    const nameOf = new Map([...applied, ...known].map((tag) => [tag.id, tag.name]));
    await this.audit.record(tx, {
      action: 'process.tags_update',
      entityType: PROCESS_ENTITY,
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'tags', old: applied.map((tag) => tag.name), new: next.map((t) => t.name) },
      ],
      metadata: {
        processCode: process.code,
        version: processVersion,
        added: diff.added.map((id) => nameOf.get(id) ?? id),
        removed: diff.removed.map((id) => nameOf.get(id) ?? id),
      },
    });
    await this.outbox.record(
      tx,
      ProcessUpdated.of({
        aggregateId: process.id,
        processId: process.id,
        payload: { changedFields: ['tags'], version: processVersion },
      }),
    );
    return {
      data: { tags: next.map(toTagDto) },
      processVersion,
      processId: process.id,
      added: diff.added.length,
      removed: diff.removed.length,
      noop: false,
    };
  }

  protected override committed(result: SetProcessTagsResult, durationMs: number): void {
    if (result.noop) return;
    const { tenantId, actor, correlationId } = requireRequestContext();
    // Nunca logar nomes de etiqueta nem dados do processo (story · "Logs").
    this.logger.log(
      {
        event: 'process.tags_changed',
        processId: result.processId,
        added: result.added,
        removed: result.removed,
        durationMs,
        tenantId,
        userId: actor.userId,
        correlationId,
      },
      'process.tags_changed',
    );
  }
}
