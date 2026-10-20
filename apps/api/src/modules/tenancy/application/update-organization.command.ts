import { OrganizationUpdated } from '@contrataflow/validation';
import type { OrganizationDto, UpdateOrganization } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  ORGANIZATION_CLOCK,
  ORGANIZATION_LOGO_PORT,
  ORGANIZATION_REPOSITORY,
  ORGANIZATION_TRANSACTIONS,
  OrganizationCnpjTakenError,
  OrganizationShortNameTakenError,
} from './organization-ports.js';
import type {
  OrganizationClock,
  OrganizationLogoPort,
  OrganizationRepository,
  OrganizationTransactions,
} from './organization-ports.js';
import {
  cnpjTaken,
  logoRejected,
  logSaveFailure,
  organizationNotFound,
  primaryOrganizationRequired,
  shortNameTaken,
  versionConflict,
} from './organization.errors.js';
import { maskCnpj, toOrganizationDto } from './organization.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { PrimaryOrganizationRequiredError, updateOrganization } from '../domain/organization.js';
import type { Organization, OrganizationUpdatableField } from '../domain/organization.js';

export interface UpdateOrganizationInput {
  readonly id: string;
  readonly patch: UpdateOrganization;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

interface UpdateOutcome {
  readonly organization: Organization;
  readonly primaryId: string | null;
  readonly written: boolean;
  readonly changedFields: readonly OrganizationUpdatableField[];
}

/**
 * `UpdateOrganizationCommand` — ORG-04 (US-101 · fluxo principal, passos 7–8), inclusive inativar e
 * reativar. Autoriza (`ORGANIZATION_MANAGE` + MFA), lê o órgão sob a RLS (outro tenant → 404),
 * confere a versão (412), reaplica unicidade, RN-TEN-41 (órgão principal / único ativo) e
 * RN-TEN-42 (logotipo) e, na mesma transação, grava `organization.update` (valores anterior e novo)
 * e `OrganizationUpdated`. Nada alterado → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class UpdateOrganizationCommand {
  private readonly logger = new Logger('Organizations');

  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATION_TRANSACTIONS) private readonly transactions: OrganizationTransactions,
    @Inject(ORGANIZATION_CLOCK) private readonly clock: OrganizationClock,
    @Inject(ORGANIZATION_LOGO_PORT) private readonly logos: OrganizationLogoPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: UpdateOrganizationInput): Promise<OrganizationDto> {
    this.access.assertCan('ORGANIZATION_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let outcome: UpdateOutcome;
    try {
      outcome = await this.transactions.run((tx) => this.apply(tx, input, now));
    } catch (error) {
      logSaveFailure(this.logger, error, context.correlationId);
      throw error;
    }

    if (outcome.written) {
      this.logger.log(
        {
          event: 'organization.updated',
          organizationId: outcome.organization.id,
          changedFields: outcome.changedFields,
          cnpj: maskCnpj(outcome.organization.cnpj),
          tenantId: outcome.organization.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'organization.updated',
      );
    }
    return toOrganizationDto(outcome.organization, outcome.primaryId);
  }

  private async apply(
    tx: TenantTx,
    input: UpdateOrganizationInput,
    now: Date,
  ): Promise<UpdateOutcome> {
    const context = requireRequestContext();
    const current = await this.organizations.findById(tx, input.id);
    if (!current) throw organizationNotFound();
    if (current.version !== input.expectedVersion) {
      throw versionConflict(current.version);
    }

    const primaryId = await this.organizations.primaryOrganizationId(tx);
    const otherActiveCount = await this.organizations.countActive(tx, current.id);
    let result;
    try {
      result = updateOrganization(current, input.patch, {
        now,
        userId: context.actor.userId,
        isPrimary: current.id === primaryId,
        otherActiveCount,
      });
    } catch (error) {
      if (error instanceof PrimaryOrganizationRequiredError) {
        this.logger.warn(
          {
            event: 'organization.deactivate_blocked',
            organizationId: current.id,
            reason: error.reason,
            tenantId: current.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          'organization.deactivate_blocked',
        );
        throw primaryOrganizationRequired(error);
      }
      throw error;
    }
    if (result.changedFields.length === 0) {
      return { organization: current, primaryId, written: false, changedFields: [] };
    }

    const { next } = result;
    if (result.changedFields.includes('shortName')) {
      const other = await this.organizations.findByShortName(tx, next.shortName);
      if (other && other.id !== current.id) throw shortNameTaken();
    }
    if (result.changedFields.includes('cnpj')) {
      const other = await this.organizations.findByCnpj(tx, next.cnpj);
      if (other && other.id !== current.id) throw cnpjTaken();
    }
    if (result.logoToValidate !== null) {
      const check = await this.logos.check(tx, result.logoToValidate);
      if (check !== 'OK') throw logoRejected(check);
    }

    try {
      await this.organizations.update(tx, next, current.version);
    } catch (error) {
      if (error instanceof OrganizationShortNameTakenError) throw shortNameTaken();
      if (error instanceof OrganizationCnpjTakenError) throw cnpjTaken();
      if (error instanceof VersionConflictError) {
        // Corrida: outra transação gravou entre a leitura e o UPDATE; informa a versão vencedora.
        const latest = await this.organizations.findById(tx, current.id);
        throw versionConflict(latest?.version ?? current.version + 1);
      }
      throw error;
    }
    await this.audit.record(tx, {
      action: 'organization.update',
      entityType: 'Organization',
      entityId: current.id,
      changes: result.changes,
      metadata: { shortName: current.shortName },
    });
    await this.outbox.record(
      tx,
      OrganizationUpdated.of({
        aggregateId: current.id,
        payload: { organizationId: current.id, changedFields: [...result.changedFields] },
      }),
    );
    return {
      organization: { ...next, version: current.version + 1 },
      primaryId,
      written: true,
      changedFields: result.changedFields,
    };
  }
}
