import { ADVANCE_ACTIONS } from '@contrataflow/validation';
import type {
  StageType,
  TransitionAction,
  WfParallelInvalidReason,
} from '@contrataflow/validation';

/*
 * Estrutura de ramos de uma versão de workflow (US-123 · DEC-194 · RN-WF2-02..07): puro e
 * determinístico, roda sobre as etapas e transições do rascunho (WF-20/21/24) ou do snapshot
 * publicado (WF-24). Dois passos, linear no número de arestas por ramificação:
 *
 * 1. **Blocos:** para cada `PARALLEL_SPLIT` (em ordem de `key`), cada transição `FORWARD` de saída
 *    abre um ramo; uma busca em largura com várias origens (uma por ramo) percorre as arestas de
 *    avanço sem atravessar junções, fins nem outras ramificações. A primeira origem que alcança uma
 *    etapa é a dona dela; a `key` da primeira etapa do ramo é o `branchKey` (RN-WF2-07).
 * 2. **Regras:** sobre o subgrafo marcado, aplica RN-WF2-02..06 e devolve TODOS os problemas, cada
 *    um com `reason` do catálogo fechado `WF_PARALLEL_INVALID_REASONS`.
 *
 * "Antes da ramificação" = alcançável a partir da `START` pelas arestas de avanço sem passar pela
 * ramificação (o mesmo critério de "anterior" da RN-WF-10).
 */

/** Etapa vista pela análise (o rascunho e o snapshot publicado satisfazem). */
export interface ParallelGraphStage {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly type: StageType;
}

export interface ParallelGraphTransition {
  readonly key: string;
  readonly name: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly action: TransitionAction;
}

export interface ParallelGraph {
  readonly stages: readonly ParallelGraphStage[];
  readonly transitions: readonly ParallelGraphTransition[];
}

export interface ParallelIssue {
  readonly reason: WfParallelInvalidReason;
  readonly message: string;
  readonly stageKey: string | null;
  readonly transitionKey: string | null;
}

export interface ParallelBranch {
  readonly branchKey: string;
  readonly entryStageKey: string;
  /** Etapas do ramo na ordem da busca a partir da primeira. */
  readonly stageKeys: readonly string[];
  readonly exitTransitionKey: string | null;
}

export interface ParallelBlock {
  readonly splitStageKey: string;
  readonly joinStageKey: string | null;
  readonly branches: readonly ParallelBranch[];
  readonly issues: readonly ParallelIssue[];
}

export interface ParallelStructure {
  readonly blocks: readonly ParallelBlock[];
  /** Problemas sem ramificação de origem (junção solta e a sua saída). */
  readonly issues: readonly ParallelIssue[];
  /** `key` da etapa → `branchKey` (só etapas de ramos; split, join e tronco ficam de fora). */
  readonly stageBranch: ReadonlyMap<string, string>;
}

const ADVANCE = new Set<TransitionAction>(ADVANCE_ACTIONS);
const BACKWARD = new Set<TransitionAction>(['RETURN', 'REJECT']);

const byKey = (a: { key: string }, b: { key: string }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

interface BranchState {
  readonly entry: ParallelGraphStage;
  readonly stages: ParallelGraphStage[];
  readonly joins: Set<string>;
  readonly exits: ParallelGraphTransition[];
  escaped: boolean;
}

/** Coletor de problemas sem repetição (mesmo `reason`, etapa e transição). */
class IssueList {
  readonly items: ParallelIssue[] = [];
  private readonly seen = new Set<string>();

  add(
    reason: WfParallelInvalidReason,
    message: string,
    target: { stageKey?: string | null; transitionKey?: string | null },
  ): void {
    const stageKey = target.stageKey ?? null;
    const transitionKey = target.transitionKey ?? null;
    const id = `${reason}|${stageKey ?? ''}|${transitionKey ?? ''}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.items.push({ reason, message, stageKey, transitionKey });
  }
}

export function analyzeParallelStructure(graph: ParallelGraph): ParallelStructure {
  const stagesById = new Map(graph.stages.map((stage) => [stage.id, stage]));
  // Transições com as duas pontas na versão, em ordem de `key` (determinismo).
  const transitions = graph.transitions
    .filter((t) => stagesById.has(t.fromStageId) && stagesById.has(t.toStageId))
    .slice()
    .sort(byKey);
  const outgoing = new Map<string, ParallelGraphTransition[]>();
  for (const transition of transitions) {
    const list = outgoing.get(transition.fromStageId);
    if (list) list.push(transition);
    else outgoing.set(transition.fromStageId, [transition]);
  }
  const advanceOut = (stageId: string) =>
    (outgoing.get(stageId) ?? []).filter((t) => ADVANCE.has(t.action));
  /** As transições já foram filtradas pelas duas pontas na versão: a etapa sempre existe. */
  const stageOf = (id: string): ParallelGraphStage => {
    const stage = stagesById.get(id);
    if (!stage) throw new Error(`Etapa ${id} fora da versão.`);
    return stage;
  };
  const start = graph.stages.filter((stage) => stage.type === 'START').sort(byKey)[0] ?? null;
  const joins = graph.stages.filter((stage) => stage.type === 'PARALLEL_JOIN').sort(byKey);
  const splits = graph.stages.filter((stage) => stage.type === 'PARALLEL_SPLIT').sort(byKey);

  /** Alcançável a partir da `START` pelas arestas de avanço sem entrar em `blocked`. */
  const reachableAvoiding = (blocked: string): Set<string> => {
    const seen = new Set<string>();
    if (!start || start.id === blocked) return seen;
    const queue = [start.id];
    seen.add(start.id);
    for (const current of queue) {
      for (const transition of advanceOut(current)) {
        const next = transition.toStageId;
        if (next === blocked || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const blocks: ParallelBlock[] = [];
  const stageBranch = new Map<string, string>();
  const joinOwner = new Map<string, string>();
  const joinsReached = new Set<string>();
  const joinIssues = new Map<string, IssueList>();

  for (const split of splits) {
    const issues = new IssueList();
    const before = reachableAvoiding(split.id);
    const entries = advanceOut(split.id).filter((t) => t.action === 'FORWARD');
    if (entries.length < 2) {
      issues.add(
        'SPLIT_BRANCHES_MIN',
        `A ramificação "${split.name}" precisa de pelo menos dois ramos. Adicione outro caminho.`,
        { stageKey: split.key },
      );
    }

    const branches: BranchState[] = [];
    const owner = new Map<string, BranchState>();
    const emptyJoins = new Set<string>();
    const queue: string[] = [];
    for (const entry of entries) {
      const target = stageOf(entry.toStageId);
      if (target.type === 'PARALLEL_JOIN') {
        emptyJoins.add(target.id);
        issues.add(
          'BRANCH_EMPTY',
          `O ramo "${entry.name}" não tem nenhuma etapa. Adicione uma etapa ou remova o ramo.`,
          { stageKey: split.key, transitionKey: entry.key },
        );
        continue;
      }
      if (target.type === 'PARALLEL_SPLIT') {
        issues.add(
          'NESTED_SPLIT',
          'Não é possível ramificar dentro de um ramo. Use apenas um nível de ramificação.',
          { stageKey: target.key, transitionKey: entry.key },
        );
        continue;
      }
      // Destino START/END: a compatibilidade ação × tipo já o recusa (WF_TRANSITION_TARGET_INVALID).
      if (target.type !== 'TASK' && target.type !== 'APPROVAL') continue;
      if (owner.has(target.id)) continue;
      const branch: BranchState = {
        entry: target,
        stages: [target],
        joins: new Set(),
        exits: [],
        escaped: false,
      };
      branches.push(branch);
      owner.set(target.id, branch);
      queue.push(target.id);
    }

    const escape = (branch: BranchState, from: ParallelGraphStage, t: ParallelGraphTransition) => {
      branch.escaped = true;
      issues.add(
        'BRANCH_ESCAPES',
        `O ramo de "${branch.entry.name}" precisa terminar na junção, não no fim do processo nem antes da ramificação.`,
        { stageKey: from.key, transitionKey: t.key },
      );
    };

    // Busca em largura com várias origens: o iterador vê os itens acrescentados no laço.
    for (const currentId of queue) {
      const current = stageOf(currentId);
      const branch = owner.get(currentId);
      if (!branch) continue;
      for (const transition of advanceOut(currentId)) {
        const next = stageOf(transition.toStageId);
        if (transition.action === 'COMPLETE' || next.type === 'END') {
          escape(branch, current, transition);
          continue;
        }
        if (next.type === 'PARALLEL_JOIN') {
          branch.joins.add(next.id);
          branch.exits.push(transition);
          continue;
        }
        if (next.id === split.id || (before.has(next.id) && !owner.has(next.id))) {
          escape(branch, current, transition);
          continue;
        }
        if (next.type === 'PARALLEL_SPLIT') {
          issues.add(
            'NESTED_SPLIT',
            'Não é possível ramificar dentro de um ramo. Use apenas um nível de ramificação.',
            { stageKey: next.key, transitionKey: transition.key },
          );
          continue;
        }
        const nextOwner = owner.get(next.id);
        if (nextOwner === undefined) {
          owner.set(next.id, branch);
          branch.stages.push(next);
          queue.push(next.id);
        } else if (nextOwner !== branch) {
          issues.add(
            'CROSS_BRANCH_TRANSITION',
            `A transição "${transition.name}" liga dois ramos diferentes. Os ramos só se encontram na junção.`,
            { stageKey: current.key, transitionKey: transition.key },
          );
        }
      }
    }

    // Entrada num ramo por fora da ramificação (de etapa que não é de nenhum ramo do bloco).
    for (const transition of transitions) {
      if (!ADVANCE.has(transition.action)) continue;
      const target = owner.get(transition.toStageId);
      if (!target || owner.has(transition.fromStageId)) continue;
      if (transition.fromStageId === split.id) continue;
      issues.add(
        'CROSS_BRANCH_TRANSITION',
        `A transição "${transition.name}" entra no ramo "${target.entry.key}" sem passar pela ramificação "${split.name}".`,
        { stageKey: stageOf(transition.fromStageId).key, transitionKey: transition.key },
      );
    }

    // RN-WF2-06: devoluções (RETURN/REJECT) ao redor do bloco.
    for (const transition of transitions) {
      if (!BACKWARD.has(transition.action)) continue;
      const fromBranch = owner.get(transition.fromStageId);
      const toBranch = owner.get(transition.toStageId);
      const invalid =
        (toBranch !== undefined && toBranch !== fromBranch) ||
        (fromBranch !== undefined && toBranch === undefined && !before.has(transition.toStageId));
      if (!invalid) continue;
      issues.add(
        'RETURN_TARGET_INVALID',
        toBranch === undefined
          ? `A devolução "${transition.name}" precisa voltar para uma etapa do mesmo ramo ou anterior à ramificação.`
          : `A devolução "${transition.name}" não pode entrar no meio de um ramo.`,
        { stageKey: stageOf(transition.fromStageId).key, transitionKey: transition.key },
      );
    }

    // RN-WF2-02/04: exatamente uma junção comum a todos os ramos.
    const blockJoins = new Set<string>(emptyJoins);
    for (const branch of branches) for (const join of branch.joins) blockJoins.add(join);
    for (const join of blockJoins) joinsReached.add(join);
    const commonMessage = `A ramificação "${split.name}" precisa terminar em uma única junção comum aos ramos.`;
    let join: ParallelGraphStage | null = null;
    if (blockJoins.size === 0) {
      issues.add('SPLIT_JOIN_MISSING', commonMessage, { stageKey: split.key });
    } else if (blockJoins.size > 1) {
      issues.add('JOIN_NOT_COMMON', commonMessage, { stageKey: split.key });
    } else {
      const [onlyJoin = ''] = blockJoins;
      join = stageOf(onlyJoin);
      if (branches.some((branch) => !branch.escaped && !branch.joins.has(join?.id ?? ''))) {
        issues.add('JOIN_NOT_COMMON', commonMessage, { stageKey: split.key });
      }
      const claimedBy = joinOwner.get(join.id);
      if (claimedBy === undefined) {
        joinOwner.set(join.id, split.key);
        joinIssues.set(join.id, issues);
        // A junção só recebe os ramos do próprio bloco.
        for (const transition of transitions) {
          if (transition.toStageId !== join.id || !ADVANCE.has(transition.action)) continue;
          if (owner.has(transition.fromStageId) || transition.fromStageId === split.id) continue;
          issues.add(
            'JOIN_WITHOUT_SPLIT',
            `A transição "${transition.name}" chega à junção "${join.name}" sem vir de um ramo da ramificação "${split.name}".`,
            { stageKey: join.key, transitionKey: transition.key },
          );
        }
      } else {
        issues.add(
          'JOIN_NOT_COMMON',
          `A junção "${join.name}" já fecha a ramificação ${claimedBy}; cada ramificação tem a sua junção.`,
          { stageKey: split.key },
        );
        join = null;
      }
    }

    for (const branch of branches) {
      for (const stage of branch.stages) {
        if (!stageBranch.has(stage.key)) stageBranch.set(stage.key, branch.entry.key);
      }
    }
    blocks.push({
      splitStageKey: split.key,
      joinStageKey: join?.key ?? null,
      branches: branches.map((branch) => ({
        branchKey: branch.entry.key,
        entryStageKey: branch.entry.key,
        stageKeys: branch.stages.map((stage) => stage.key),
        exitTransitionKey:
          branch.exits.find((transition) => transition.toStageId === join?.id)?.key ?? null,
      })),
      issues: issues.items,
    });
  }

  // Junções: soltas (sem ramificação) e a saída única para TASK/APPROVAL (RN-WF2-03/05).
  const orphan = new IssueList();
  for (const join of joins) {
    const target = joinIssues.get(join.id) ?? orphan;
    if (!joinsReached.has(join.id)) {
      target.add(
        'JOIN_WITHOUT_SPLIT',
        `A junção "${join.name}" não está ligada a nenhuma ramificação.`,
        {
          stageKey: join.key,
        },
      );
    }
    const exits = outgoing.get(join.id) ?? [];
    const exit = exits[0];
    const exitOk =
      exits.length === 1 &&
      exit?.action === 'FORWARD' &&
      ['TASK', 'APPROVAL'].includes(stageOf(exit.toStageId).type);
    if (!exitOk) {
      target.add(
        'JOIN_EXIT_INVALID',
        `A junção "${join.name}" precisa de uma única saída para a etapa seguinte.`,
        { stageKey: join.key },
      );
    }
  }

  return { blocks, issues: orphan.items, stageBranch };
}

/** Todos os problemas da estrutura (dos blocos e soltos), na ordem estável da análise. */
export function parallelIssues(structure: ParallelStructure): ParallelIssue[] {
  return [...structure.blocks.flatMap((block) => block.issues), ...structure.issues];
}

/**
 * `BranchKeyResolver` (RN-WF2-07): `branchKey` de cada etapa por id — a `key` da primeira etapa do
 * ramo; `null` fora de ramos, no split e no join.
 */
export function resolveBranchKeys(graph: ParallelGraph): Map<string, string | null> {
  const { stageBranch } = analyzeParallelStructure(graph);
  return new Map(graph.stages.map((stage) => [stage.id, stageBranch.get(stage.key) ?? null]));
}
