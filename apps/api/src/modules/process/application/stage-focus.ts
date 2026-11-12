import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { BranchScope } from './branch-engine.js';
import type { ProcessAggregateRows, ProcessStageRow } from './ports.js';
import { branchStageChanged, processStageInvalid, processStageRequired } from './process.errors.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import {
  activeSplitOf,
  focusProcess,
  focusStages,
  resolveTargetStage,
} from '../domain/process-branches.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

/** O processo como a ação o vê depois de escolher a etapa-alvo (US-124 · RN-WF2-17/18). */
export interface StageFocus {
  /**
   * `TRUNK` = sem ramificação e sem `processStageId`: o caminho do MVP 1, com as próprias
   * conferências de `expectedStageId`; `TARGET` = a etapa-alvo já conferida (ativa, esperada).
   */
  readonly kind: 'TRUNK' | 'TARGET';
  /** O processo está em ramificação (split ativo): as mensagens de erro falam de ramo. */
  readonly branching: boolean;
  /** Visão focada: processo, passagens e runtime como se a etapa-alvo fosse a única ativa. */
  readonly rows: ProcessAggregateRows;
  readonly runtime: ProcessRuntime;
  /** O processo real (passagens de todas as rodadas — as sequências saem daqui). */
  readonly real: { readonly rows: ProcessAggregateRows; readonly runtime: ProcessRuntime };
  /** A etapa-alvo (`null` no tronco sem passagem ativa — processo encerrado). */
  readonly target: ProcessStageRow | null;
  /** O que o `StageTransitionService` precisa para tratar ramos. */
  readonly scope: BranchScope | undefined;
}

/**
 * `StageFocusResolver` (US-124): resolve a etapa-alvo de PRC-19/20/21/22 e da decisão de aprovação
 * (`processStageId`, RN-WF2-18) e monta a VISÃO FOCADA — o motor de workflow, a custódia (POL-01
 * por etapa — RN-WF2-17) e os planos do MVP 1 rodam sobre ela sem saber de ramos. Fora da
 * ramificação e sem `processStageId`, devolve o próprio processo (`TRUNK`).
 */
@Injectable()
export class StageFocusResolver {
  constructor(private readonly support: StageTransitionSupport) {}

  async resolve(
    tx: TenantTx,
    loaded: { readonly rows: ProcessAggregateRows; readonly runtime: ProcessRuntime },
    request: { readonly processStageId?: string | null; readonly expectedStageId?: string | null },
  ): Promise<StageFocus> {
    const { rows, runtime } = loaded;
    const real = { rows, runtime };
    const branching = activeSplitOf(rows.stages) !== null;
    const resolution = resolveTargetStage(rows.process, rows.stages, request);
    switch (resolution.kind) {
      case 'REQUIRED':
        throw processStageRequired();
      case 'INVALID':
        throw processStageInvalid();
      case 'CHANGED':
        throw branchStageChanged(
          request.processStageId ?? rows.process.currentStageId,
          await this.support.lastWriter(tx, rows.process),
        );
      case 'TRUNK': {
        const target =
          rows.stages.find(
            (stage) => stage.id === rows.process.currentStageId && stage.status === 'ACTIVE',
          ) ?? null;
        return {
          kind: 'TRUNK',
          branching,
          rows,
          runtime,
          real,
          target,
          scope: target === null ? undefined : { rows, runtime, target },
        };
      }
      case 'TARGET': {
        const target = resolution.stage;
        return {
          kind: 'TARGET',
          branching,
          ...focusOn(rows, runtime, target),
          real,
          target,
          scope: { rows, runtime, target },
        };
      }
    }
  }
}

/** A visão focada na etapa-alvo (as outras ativas — split e demais ramos — saem de cena). */
export function focusOn(
  rows: ProcessAggregateRows,
  runtime: ProcessRuntime,
  target: ProcessStageRow,
): { readonly rows: ProcessAggregateRows; readonly runtime: ProcessRuntime } {
  const process = focusProcess(rows.process, target);
  if (process === rows.process) return { rows, runtime };
  return {
    rows: { ...rows, process, stages: focusStages(rows.stages, target) },
    runtime: {
      ...runtime,
      status: process.status,
      currentDepartmentId: process.currentDepartmentId,
      currentResponsibleId: process.currentResponsibleId,
      passes: runtime.passes.filter(
        (pass) => pass.status !== 'ACTIVE' || pass.processStageId === target.id,
      ),
    },
  };
}

/**
 * O processo real depois de uma ação sobre uma etapa de ramo planejada na visão focada (assumir,
 * atribuir): só a versão e o carimbo de alteração mudam — `current*` seguem os do paralelismo.
 */
export function unfocused(
  real: ProcessAggregateRows['process'],
  focusedAfter: ProcessAggregateRows['process'],
): ProcessAggregateRows['process'] {
  return {
    ...real,
    updatedAt: focusedAfter.updatedAt,
    updatedById: focusedAfter.updatedById,
    version: focusedAfter.version,
  };
}
