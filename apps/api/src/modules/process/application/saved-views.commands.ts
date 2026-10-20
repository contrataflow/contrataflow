import { SAVED_VIEW_MESSAGES } from '@contrataflow/validation';
import type {
  CreateSavedView,
  SavedViewDto,
  SavedViewScope,
  UpdateSavedView,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import {
  PROCESS_CLOCK,
  PROCESS_REPOSITORY,
  PROCESS_TRANSACTIONS,
  SAVED_VIEW_REPOSITORY,
  SavedViewNameTakenError,
} from './ports.js';
import type {
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
  SavedViewRepository,
} from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  applySavedViewPatch,
  canCreateSavedView,
  isSavedViewNameTaken,
  savedViewAccess,
} from '../domain/saved-view.js';
import type { SavedView } from '../domain/saved-view.js';

/*
 * Visões salvas (US-003 · PRC-35..38 · RN-PROC-34..38): preferência do usuário — sem evento nem
 * auditoria de negócio. Acesso ao escopo: `PROCESS_LIST` = `PROCESS_VIEW` ou concessão `USER`
 * (DEC-024 cond. 4); `INBOX` = `INBOX_VIEW`. Só o dono altera/exclui: compartilhada de outro = 403
 * (com `access.denied` da visão), privada de outro ou de outro tenant = 404. Criação, limite e
 * troca da padrão serializados por dono e escopo (`lockOwnerScope`); o índice `lower(name)` é a
 * rede de segurança do nome (409). Logs sem filtros nem nomes.
 */

const SAVED_VIEW_ENTITY = 'SavedView';

/** Permissões efetivas do vínculo da requisição (pela fachada do `access`). */
type EffectivePermissionSet = Awaited<ReturnType<AccessFacade['effectivePermissions']>>;

const notFound = () => new ApiError('NOT_FOUND', { detail: SAVED_VIEW_MESSAGES.notFound });
const nameTaken = () => new ApiError('CONFLICT', { detail: SAVED_VIEW_MESSAGES.nameTaken });

function userOfContext(): string {
  const { actor } = requireRequestContext();
  if (actor.userId === null) throw new ApiError('UNAUTHENTICATED');
  return actor.userId;
}

/** Regras comuns: acesso ao escopo, carga para alteração (posse) e apresentação. */
@Injectable()
export class SavedViewSupport {
  constructor(
    @Inject(SAVED_VIEW_REPOSITORY) private readonly views: SavedViewRepository,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly identity: IdentityFacade,
  ) {}

  /** "Permissões": quem não acessa a lista (ou a caixa) não acessa as visões dela. */
  async assertScope(
    tx: TenantTx,
    scope: SavedViewScope,
    userId: string,
    permissions: EffectivePermissionSet,
  ): Promise<void> {
    if (scope === 'INBOX') {
      if (permissions.has('INBOX_VIEW')) return;
      throw new ApiError('PERMISSION_DENIED', {
        detail: SAVED_VIEW_MESSAGES.forbidden,
        auditReasonCode: 'INBOX_VIEW',
      });
    }
    if (permissions.has('PROCESS_VIEW') || (await this.processes.hasUserGrant(tx, userId))) return;
    throw new ApiError('PERMISSION_DENIED', {
      detail: SAVED_VIEW_MESSAGES.forbidden,
      auditReasonCode: 'PROCESS_VIEW',
    });
  }

  /**
   * A visão para PATCH/DELETE: inexistente, de outro tenant (RLS) ou privada de outro = 404;
   * compartilhada de outro = 403 com `access.denied` (`entityId` da visão). Trava o dono e escopo.
   */
  async loadOwned(
    tx: TenantTx,
    id: string,
    userId: string,
    permissions: EffectivePermissionSet,
    patch: UpdateSavedView | null = null,
  ): Promise<SavedView> {
    const view = await this.views.findById(tx, id);
    if (view === null) throw notFound();
    const access = savedViewAccess(view, userId);
    if (access === 'HIDDEN') throw notFound();
    await this.assertScope(tx, view.scope, userId, permissions);
    if (access === 'SHARED') {
      // V-06: tornar padrão a visão de outro dono pede uma cópia ("Salvar como minha").
      if (patch !== null && Object.keys(patch).length === 1 && patch.isDefault === true) {
        throw validationError([
          { field: 'isDefault', code: 'NOT_ALLOWED', message: SAVED_VIEW_MESSAGES.sharedDefault },
        ]);
      }
      throw new ApiError('PERMISSION_DENIED', {
        detail: SAVED_VIEW_MESSAGES.notOwner,
        auditEntity: { type: SAVED_VIEW_ENTITY, id: view.id },
      });
    }
    await this.views.lockOwnerScope(tx, view.ownerId, view.scope);
    return view;
  }

  async present(
    tx: TenantTx,
    views: readonly SavedView[],
    userId: string,
  ): Promise<SavedViewDto[]> {
    const names = await this.identity.userDisplayNames(tx, [
      ...new Set(views.map((view) => view.ownerId)),
    ]);
    return views.map((view) => ({
      id: view.id,
      name: view.name,
      scope: view.scope,
      filters: view.filters,
      sort: view.sort,
      columns: [...view.columns],
      isShared: view.isShared,
      isDefault: view.isDefault,
      owner: { id: view.ownerId, name: names.get(view.ownerId) ?? '' },
      isOwner: view.ownerId === userId,
      version: view.version,
    }));
  }
}

/** PRC-35: as visões do usuário no escopo e, depois, as compartilhadas por outros. */
@Injectable()
export class ListSavedViewsQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(SAVED_VIEW_REPOSITORY) private readonly views: SavedViewRepository,
    private readonly access: AccessFacade,
    private readonly support: SavedViewSupport,
  ) {}

  async execute(scope: SavedViewScope): Promise<SavedViewDto[]> {
    const userId = userOfContext();
    const permissions = await this.access.effectivePermissions();
    return this.transactions.read(async (tx) => {
      await this.support.assertScope(tx, scope, userId, permissions);
      const owned = await this.views.listOwned(tx, userId, scope);
      const shared = await this.views.listSharedByOthers(tx, userId, scope);
      return this.support.present(tx, [...owned, ...shared], userId);
    });
  }
}

interface Prepared {
  readonly userId: string;
  readonly permissions: EffectivePermissionSet;
}

function logView(logger: Logger, event: string, view: SavedViewDto | SavedView): void {
  const { tenantId, correlationId } = requireRequestContext();
  logger.log(
    {
      event,
      savedViewId: view.id,
      scope: view.scope,
      isShared: view.isShared,
      isDefault: view.isDefault,
      tenantId,
      correlationId,
    },
    event,
  );
}

/** PRC-36 (`Idempotency-Key` no pipeline). */
@Injectable()
export class CreateSavedViewCommand extends TransactionalCommandHandler<
  CreateSavedView,
  Prepared,
  SavedViewDto
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(SAVED_VIEW_REPOSITORY) private readonly views: SavedViewRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly access: AccessFacade,
    private readonly support: SavedViewSupport,
  ) {
    super('saved_view.create', transactions);
  }

  protected async prepare(): Promise<Prepared> {
    return { userId: userOfContext(), permissions: await this.access.effectivePermissions() };
  }

  protected async handle(
    tx: TenantTx,
    input: CreateSavedView,
    { userId, permissions }: Prepared,
  ): Promise<SavedViewDto> {
    await this.support.assertScope(tx, input.scope, userId, permissions);
    await this.views.lockOwnerScope(tx, userId, input.scope);
    const owned = await this.views.listOwned(tx, userId, input.scope);
    if (!canCreateSavedView(owned.length)) {
      throw validationError([
        { field: 'name', code: 'NOT_ALLOWED', message: SAVED_VIEW_MESSAGES.limitReached },
      ]);
    }
    if (isSavedViewNameTaken(owned, input.name)) throw nameTaken();
    if (input.isDefault) await this.views.clearDefault(tx, userId, input.scope, null);
    const now = this.clock();
    const { tenantId } = requireRequestContext();
    const view: SavedView = {
      id: newId(),
      tenantId: tenantId ?? '',
      ownerId: userId,
      scope: input.scope,
      name: input.name,
      filters: input.filters,
      sort: input.sort ?? null,
      columns: input.columns,
      isShared: input.isShared,
      isDefault: input.isDefault,
      createdAt: now,
      updatedAt: now,
      createdById: userId,
      updatedById: userId,
      version: 1,
    };
    try {
      await this.views.insert(tx, view);
    } catch (error) {
      if (error instanceof SavedViewNameTakenError) throw nameTaken();
      throw error;
    }
    const [dto] = await this.support.present(tx, [view], userId);
    if (dto === undefined) throw new Error('Visão criada sem apresentação.');
    return dto;
  }

  protected override committed(result: SavedViewDto): void {
    logView(this.logger, 'saved_view.created', result);
  }
}

export interface UpdateSavedViewInput {
  readonly id: string;
  readonly patch: UpdateSavedView;
  readonly expectedVersion: number;
}

/** PRC-37 (`If-Match` obrigatório no pipeline). PATCH sem diferença = visão atual, sem versão. */
@Injectable()
export class UpdateSavedViewCommand extends TransactionalCommandHandler<
  UpdateSavedViewInput,
  Prepared,
  SavedViewDto
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(SAVED_VIEW_REPOSITORY) private readonly views: SavedViewRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly access: AccessFacade,
    private readonly support: SavedViewSupport,
  ) {
    super('saved_view.update', transactions);
  }

  protected async prepare(): Promise<Prepared> {
    return { userId: userOfContext(), permissions: await this.access.effectivePermissions() };
  }

  protected async handle(
    tx: TenantTx,
    input: UpdateSavedViewInput,
    { userId, permissions }: Prepared,
  ): Promise<SavedViewDto> {
    const current = await this.support.loadOwned(tx, input.id, userId, permissions, input.patch);
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError({
        aggregateType: SAVED_VIEW_ENTITY,
        aggregateId: current.id,
        expectedVersion: input.expectedVersion,
      });
    }
    const { view, changed } = applySavedViewPatch(current, input.patch, {
      at: this.clock(),
      userId,
    });
    if (changed) {
      const owned = await this.views.listOwned(tx, userId, view.scope);
      if (isSavedViewNameTaken(owned, view.name, view.id)) throw nameTaken();
      if (view.isDefault && !current.isDefault) {
        await this.views.clearDefault(tx, userId, view.scope, view.id);
      }
      try {
        await this.views.update(tx, view, input.expectedVersion);
      } catch (error) {
        if (error instanceof SavedViewNameTakenError) throw nameTaken();
        throw error;
      }
    }
    const [dto] = await this.support.present(tx, [view], userId);
    if (dto === undefined) throw new Error('Visão alterada sem apresentação.');
    return dto;
  }

  protected override committed(result: SavedViewDto): void {
    logView(this.logger, 'saved_view.updated', result);
  }
}

export interface DeleteSavedViewInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/** PRC-38 (`If-Match` obrigatório no pipeline): exclusão física. */
@Injectable()
export class DeleteSavedViewCommand extends TransactionalCommandHandler<
  DeleteSavedViewInput,
  Prepared,
  SavedView
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(SAVED_VIEW_REPOSITORY) private readonly views: SavedViewRepository,
    private readonly access: AccessFacade,
    private readonly support: SavedViewSupport,
  ) {
    super('saved_view.delete', transactions);
  }

  protected async prepare(): Promise<Prepared> {
    return { userId: userOfContext(), permissions: await this.access.effectivePermissions() };
  }

  protected async handle(
    tx: TenantTx,
    input: DeleteSavedViewInput,
    { userId, permissions }: Prepared,
  ): Promise<SavedView> {
    const view = await this.support.loadOwned(tx, input.id, userId, permissions);
    await this.views.delete(tx, view, input.expectedVersion);
    return view;
  }

  protected override committed(result: SavedView): void {
    logView(this.logger, 'saved_view.deleted', result);
  }
}
