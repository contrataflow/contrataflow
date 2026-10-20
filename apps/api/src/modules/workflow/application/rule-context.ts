import { RULE_CONTEXT_VERSION, ruleContextSchema } from '@contrataflow/validation';
import type { RuleContextV1 } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { documentsSectionOf } from '../domain/rule-facts.js';
import type { RuleDocumentFact } from '../domain/rule-facts.js';

/*
 * Montagem do `RuleContext` v1 (US-041 · DEC-016 · architecture.md §"Portas": `RuleContextContributor`
 * declarada por `workflow`). O módulo `process` é o dono de `process.*`, `stage.*` e da parte
 * genérica de `documents.*` (a semente); os módulos de artefatos (`dfd`, `etp`, `term`,
 * `price-research`, `risk` — nível 4) registram contribuidores para as suas seções, sem que
 * `workflow` ou `process` dependam deles. Tudo é lido no `tx` do chamador, somente leitura.
 */

export interface RuleContextRequest {
  readonly processId: string;
  readonly now: Date;
}

/** O que um contribuidor acrescenta ao contexto. */
export interface RuleContextContribution {
  /** Campos de `process.*` derivados de outro agregado (ex.: `itemsCount`, `hasLots`). */
  readonly process?: Partial<RuleContextV1['process']>;
  /**
   * Documentos dos tipos do contribuidor: SUBSTITUEM os da semente para os mesmos códigos (o módulo
   * tipado é a autoridade da completude do seu tipo — ex.: `documents.DFD.isComplete`).
   */
  readonly documents?: readonly RuleDocumentFact[];
  readonly priceResearch?: Partial<RuleContextV1['priceResearch']>;
  readonly risks?: Partial<RuleContextV1['risks']>;
}

export interface RuleContextContributor {
  /** Nome único (diagnóstico), ex.: `price-research`. */
  readonly name: string;
  contribute(tx: TenantTx, request: RuleContextRequest): Promise<RuleContextContribution>;
}

export class RuleContextContributorRegistrationError extends Error {
  constructor(name: string) {
    super(`Contribuidor de RuleContext ${name} já registrado.`);
    this.name = 'RuleContextContributorRegistrationError';
  }
}

/** Registro único dos contribuidores (cada módulo registra o seu no `onModuleInit`). */
@Injectable()
export class RuleContextContributorRegistry {
  private readonly contributors = new Map<string, RuleContextContributor>();

  register(contributor: RuleContextContributor): void {
    if (this.contributors.has(contributor.name)) {
      throw new RuleContextContributorRegistrationError(contributor.name);
    }
    this.contributors.set(contributor.name, contributor);
  }

  /** Na ordem de registro. */
  all(): readonly RuleContextContributor[] {
    return [...this.contributors.values()];
  }
}

/** O contexto montado viola o schema v1: defeito de um contribuidor (500, nunca dado ao usuário). */
export class RuleContextInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super('RuleContext v1 inválido.');
    this.name = 'RuleContextInvalidError';
  }
}

/** Semente do módulo `process`: o agregado, a passagem ativa e os documentos do processo. */
export interface RuleContextSeed extends RuleContextRequest {
  readonly process: RuleContextV1['process'];
  /** Etapa da passagem ativa; `null` = processo sem etapa ativa. */
  readonly stage: { readonly key: string; readonly enteredAt: Date } | null;
  readonly documents: readonly RuleDocumentFact[];
}

export interface BuiltRuleContext {
  readonly context: RuleContextV1;
  /** Documentos efetivos (semente + substituições dos contribuidores). */
  readonly documents: readonly RuleDocumentFact[];
}

const EMPTY_PRICE_RESEARCH: RuleContextV1['priceResearch'] = Object.freeze({
  exists: false,
  completed: false,
  totalEstimatedValue: null,
  itemsBelowMinimum: 0,
  itemsWithOutliers: 0,
  itemsWithoutValidQuotes: 0,
});

const EMPTY_RISKS: RuleContextV1['risks'] = Object.freeze({
  count: 0,
  highOrExtremeCount: 0,
  withoutTreatmentCount: 0,
});

/** `RuleContextBuilder` (domains.md §5): semente + contribuidores → `RuleContextV1` validado. */
@Injectable()
export class RuleContextBuilder {
  constructor(
    private readonly registry: RuleContextContributorRegistry,
    private readonly calendar: BusinessCalendarFacade,
  ) {}

  async build(tx: TenantTx, seed: RuleContextSeed): Promise<BuiltRuleContext> {
    let process = seed.process;
    let documents = [...seed.documents];
    let priceResearch = EMPTY_PRICE_RESEARCH;
    let risks = EMPTY_RISKS;
    const request: RuleContextRequest = { processId: seed.processId, now: seed.now };
    for (const contributor of this.registry.all()) {
      const contribution = await contributor.contribute(tx, request);
      if (contribution.process) process = { ...process, ...contribution.process };
      if (contribution.documents) {
        const replaced = new Set(contribution.documents.map((item) => item.documentTypeCode));
        documents = [
          ...documents.filter((item) => !replaced.has(item.documentTypeCode)),
          ...contribution.documents,
        ];
      }
      if (contribution.priceResearch) {
        priceResearch = { ...priceResearch, ...contribution.priceResearch };
      }
      if (contribution.risks) risks = { ...risks, ...contribution.risks };
    }

    const stage =
      seed.stage === null
        ? { key: '', enteredAt: seed.now.toISOString(), businessDaysInStage: 0 }
        : {
            key: seed.stage.key,
            enteredAt: seed.stage.enteredAt.toISOString(),
            businessDaysInStage: await this.calendar.businessDaysElapsed(
              tx,
              seed.stage.enteredAt,
              seed.now,
            ),
          };
    const candidate: RuleContextV1 = {
      version: RULE_CONTEXT_VERSION,
      now: seed.now.toISOString(),
      process,
      documents: documentsSectionOf(documents),
      priceResearch,
      risks,
      stage,
    };
    const parsed = ruleContextSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new RuleContextInvalidError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
      );
    }
    return { context: parsed.data, documents };
  }
}
