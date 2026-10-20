import { OrganizationCreated } from '@contrataflow/validation';
import type { CreateOrganization, OrganizationDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  ORGANIZATION_CLOCK,
  ORGANIZATION_REPOSITORY,
  ORGANIZATION_TRANSACTIONS,
  OrganizationCnpjTakenError,
  OrganizationShortNameTakenError,
} from './organization-ports.js';
import type {
  OrganizationClock,
  OrganizationRepository,
  OrganizationTransactions,
} from './organization-ports.js';
import { cnpjTaken, logSaveFailure, shortNameTaken } from './organization.errors.js';
import { maskCnpj, toOrganizationDto } from './organization.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { createOrganization } from '../domain/organization.js';
import type { Organization } from '../domain/organization.js';

export interface CreateOrganizationInput {
  readonly body: CreateOrganization;
}

/** Campos informados pelo cliente (evento e auditoria): só os que vieram no corpo. */
function informedFields(body: CreateOrganization): string[] {
  return Object.entries(body)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field]) => field);
}

/**
 * `CreateOrganizationCommand` — ORG-02 (US-101 · fluxo principal, passos 4–6): autoriza
 * (`ORGANIZATION_MANAGE` + MFA), valida a unicidade de sigla e CNPJ no tenant e, numa transação,
 * insere o órgão (`isActive = true`), grava `organization.create` e `OrganizationCreated`. O DV do
 * CNPJ e os formatos já foram conferidos pelo schema Zod na borda.
 */
@Injectable()
export class CreateOrganizationCommand {
  private readonly logger = new Logger('Organizations');

  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATION_TRANSACTIONS) private readonly transactions: OrganizationTransactions,
    @Inject(ORGANIZATION_CLOCK) private readonly clock: OrganizationClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: CreateOrganizationInput): Promise<OrganizationDto> {
    this.access.assertCan('ORGANIZATION_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const draft = createOrganization(input.body, {
      id: newId(),
      tenantId: context.tenantId ?? '',
      now,
      userId: context.actor.userId,
    });
    const changedFields = informedFields(input.body);

    let created: Organization;
    let primaryId: string | null;
    try {
      ({ created, primaryId } = await this.transactions.run(async (tx) => {
        if (await this.organizations.findByShortName(tx, draft.shortName)) throw shortNameTaken();
        if (await this.organizations.findByCnpj(tx, draft.cnpj)) throw cnpjTaken();
        try {
          await this.organizations.insert(tx, draft);
        } catch (error) {
          // Corrida de duas criações: o índice único decide.
          if (error instanceof OrganizationShortNameTakenError) throw shortNameTaken();
          if (error instanceof OrganizationCnpjTakenError) throw cnpjTaken();
          throw error;
        }
        const changes: AuditChange[] = changedFields.map((path) => ({
          path,
          old: null,
          new: draft[path as keyof Organization],
        }));
        await this.audit.record(tx, {
          action: 'organization.create',
          entityType: 'Organization',
          entityId: draft.id,
          changes,
          metadata: { shortName: draft.shortName },
        });
        await this.outbox.record(
          tx,
          OrganizationCreated.of({
            aggregateId: draft.id,
            payload: { organizationId: draft.id },
          }),
        );
        return { created: draft, primaryId: await this.organizations.primaryOrganizationId(tx) };
      }));
    } catch (error) {
      logSaveFailure(this.logger, error, context.correlationId);
      throw error;
    }

    this.logger.log(
      {
        event: 'organization.created',
        organizationId: created.id,
        changedFields,
        cnpj: maskCnpj(created.cnpj),
        tenantId: created.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'organization.created',
    );
    return toOrganizationDto(created, primaryId);
  }
}
