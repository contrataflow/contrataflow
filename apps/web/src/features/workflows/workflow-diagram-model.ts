import { ADVANCE_ACTIONS } from '@contrataflow/validation';
import type { WorkflowStageDto, WorkflowTransitionDto } from '@contrataflow/validation';

import { sortStages } from './workflow-editor-model';

/*
 * Diagrama do workflow (US-046 · SCR-034, aba "Diagrama"): funções puras que transformam as etapas
 * e transições de WF-09 em nós e arestas posicionados. Nenhuma posição é persistida (RN-WF-71): o
 * layout é recalculado a cada carregamento por um layout hierárquico em camadas (esquerda → direita)
 * — próprio, sem elkjs/React Flow, que seriam dependências novas fora do catálogo (RN-FND-11, mesma
 * decisão do `ConditionBuilder` da US-044).
 */

export type DiagramStage = Pick<
  WorkflowStageDto,
  'id' | 'key' | 'name' | 'type' | 'color' | 'groupLabel' | 'displayOrder' | 'slaDays' | 'slaType'
>;
export type DiagramTransition = Pick<
  WorkflowTransitionDto,
  'id' | 'key' | 'name' | 'action' | 'fromStageId' | 'toStageId' | 'isPrimary' | 'displayOrder'
>;

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 88;
const RANK_GAP = 112;
const ORDER_GAP = 48;
const PADDING = 32;
/** Faixa abaixo dos nós por aresta de retorno (devoluções desenhadas por baixo). */
const BACK_LANE = 28;
/** Deslocamento vertical entre arestas paralelas do mesmo par de etapas. */
const PARALLEL_OFFSET = 14;
const CROSSING_SWEEPS = 4;

/** Acima disto o diagrama abre ajustado à tela e com minimapa (FA-02). */
export const LARGE_DIAGRAM_STAGES = 20;

/** Grafo malformado (FA-04 · RN-WF-75): a tela cai para a lista simples. */
export class DiagramLayoutError extends Error {
  constructor(
    readonly reason: 'DUPLICATE_STAGE' | 'UNKNOWN_STAGE',
    readonly itemKey: string,
  ) {
    super(`Diagrama sem layout: ${reason} (${itemKey})`);
    this.name = 'DiagramLayoutError';
  }
}

export interface StageReachability {
  /** Não alcançável a partir da etapa `START` pelas ações de avanço (`WF_STAGE_UNREACHABLE`). */
  readonly unreachable: boolean;
  /** Sem caminho de avanço até uma etapa `END` (`WF_END_UNREACHABLE`). */
  readonly noPathToEnd: boolean;
}

function adjacency(pairs: readonly (readonly [string, string])[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [from, to] of pairs) map.set(from, [...(map.get(from) ?? []), to]);
  return map;
}

function reachable(sources: readonly string[], edges: Map<string, string[]>): Set<string> {
  const seen = new Set(sources);
  const queue = [...sources];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const next of edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * RN-WF-74: mesmo critério do validador da API (`WF_STAGE_UNREACHABLE`/`WF_END_UNREACHABLE`) —
 * só as ações de avanço contam; sem etapa `START` (ou sem `END`) o respectivo aviso não se aplica.
 * Só as etapas com aviso entram no mapa.
 */
export function stageReachability(
  stages: readonly Pick<DiagramStage, 'id' | 'type'>[],
  transitions: readonly Pick<DiagramTransition, 'fromStageId' | 'toStageId' | 'action'>[],
): Map<string, StageReachability> {
  const advance = transitions.filter((transition) => ADVANCE_ACTIONS.includes(transition.action));
  const starts = stages.filter((stage) => stage.type === 'START').map((stage) => stage.id);
  const ends = stages.filter((stage) => stage.type === 'END').map((stage) => stage.id);
  const fromStart =
    starts.length > 0
      ? reachable(starts, adjacency(advance.map((t) => [t.fromStageId, t.toStageId] as const)))
      : null;
  const toEnd =
    ends.length > 0
      ? reachable(ends, adjacency(advance.map((t) => [t.toStageId, t.fromStageId] as const)))
      : null;
  const result = new Map<string, StageReachability>();
  for (const stage of stages) {
    const unreachable = fromStart !== null && !fromStart.has(stage.id);
    const noPathToEnd = toEnd !== null && !toEnd.has(stage.id);
    if (unreachable || noPathToEnd) result.set(stage.id, { unreachable, noPathToEnd });
  }
  return result;
}

export interface DiagramNode {
  readonly stage: DiagramStage;
  readonly rank: number;
  readonly x: number;
  readonly y: number;
  readonly warning: StageReachability | null;
}

export interface DiagramEdge {
  readonly transition: DiagramTransition;
  /** Volta para uma camada anterior (devolução, ciclo): desenhada por baixo dos nós. */
  readonly back: boolean;
  /** Caminho SVG (`d`). */
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
}

export interface DiagramLayout {
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly width: number;
  readonly height: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Camadas por caminho mais longo sobre o grafo sem ciclos: a busca em profundidade parte do `START`
 * (depois as demais etapas na ordem de exibição), segue primeiro as ações de avanço e marca como
 * "de retorno" as arestas que voltam para uma etapa ainda na pilha (devoluções e laços).
 */
function rankStages(
  stages: readonly DiagramStage[],
  transitions: readonly DiagramTransition[],
  order: ReadonlyMap<string, number>,
): { ranks: Map<string, number>; back: Set<string> } {
  const outgoing = new Map<string, DiagramTransition[]>();
  for (const transition of transitions) {
    outgoing.set(transition.fromStageId, [
      ...(outgoing.get(transition.fromStageId) ?? []),
      transition,
    ]);
  }
  const advanceFirst = (a: DiagramTransition, b: DiagramTransition) =>
    Number(!ADVANCE_ACTIONS.includes(a.action)) - Number(!ADVANCE_ACTIONS.includes(b.action)) ||
    (order.get(a.toStageId) ?? 0) - (order.get(b.toStageId) ?? 0) ||
    a.displayOrder - b.displayOrder;
  for (const list of outgoing.values()) list.sort(advanceFirst);

  const back = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const roots = [
    ...stages.filter((stage) => stage.type === 'START'),
    ...stages.filter((stage) => stage.type !== 'START'),
  ];
  for (const root of roots) {
    if (state.has(root.id)) continue;
    // Pilha explícita (sem recursão): [etapa, índice da próxima aresta].
    const stack: [string, number][] = [[root.id, 0]];
    state.set(root.id, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const [current, index] = top;
      const edge = outgoing.get(current)?.[index];
      if (!edge) {
        state.set(current, 'done');
        stack.pop();
        continue;
      }
      top[1] = index + 1;
      const target = state.get(edge.toStageId);
      if (target === 'open') {
        back.add(edge.id);
      } else if (target === undefined) {
        state.set(edge.toStageId, 'open');
        stack.push([edge.toStageId, 0]);
      }
    }
  }

  // Kahn com desempate pela ordem de exibição; rank = maior rank dos antecessores + 1.
  const forward = transitions.filter((transition) => !back.has(transition.id));
  const indegree = new Map(stages.map((stage) => [stage.id, 0]));
  for (const transition of forward) {
    indegree.set(transition.toStageId, (indegree.get(transition.toStageId) ?? 0) + 1);
  }
  const ranks = new Map(stages.map((stage) => [stage.id, 0]));
  const ready = stages.filter((stage) => indegree.get(stage.id) === 0).map((stage) => stage.id);
  while (ready.length > 0) {
    ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const current = ready.shift();
    if (current === undefined) break;
    for (const transition of forward) {
      if (transition.fromStageId !== current) continue;
      const next = transition.toStageId;
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(current) ?? 0) + 1));
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return { ranks, back };
}

/** Ordem dentro de cada camada: varreduras de baricentro (desce e sobe) para reduzir cruzamentos. */
function orderLayers(
  layers: string[][],
  forward: readonly DiagramTransition[],
  order: ReadonlyMap<string, number>,
): void {
  const position = new Map<string, number>();
  const remember = () => {
    for (const layer of layers) layer.forEach((id, index) => position.set(id, index));
  };
  remember();
  const neighbours = (id: string, direction: 'up' | 'down') =>
    forward
      .filter((t) => (direction === 'up' ? t.toStageId === id : t.fromStageId === id))
      .map((t) => position.get(direction === 'up' ? t.fromStageId : t.toStageId) ?? 0);
  const sweep = (layer: string[], direction: 'up' | 'down') => {
    const keyed = layer.map((id, index) => {
      const values = neighbours(id, direction);
      const center =
        values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : index;
      return { id, center, index };
    });
    keyed.sort(
      (a, b) =>
        a.center - b.center || a.index - b.index || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    layer.splice(0, layer.length, ...keyed.map((item) => item.id));
    remember();
  };
  for (let iteration = 0; iteration < CROSSING_SWEEPS; iteration += 1) {
    for (let rank = 1; rank < layers.length; rank += 1) sweep(layers[rank] ?? [], 'up');
    for (let rank = layers.length - 2; rank >= 0; rank -= 1) sweep(layers[rank] ?? [], 'down');
  }
}

/**
 * Layout automático (RN-WF-71): camadas da esquerda para a direita, arestas de avanço da direita de
 * uma etapa para a esquerda da seguinte e arestas de retorno curvadas por baixo dos nós, cada uma
 * na sua faixa. Lança `DiagramLayoutError` para grafo malformado (FA-04).
 */
export function layoutDiagram(
  stagesInput: readonly DiagramStage[],
  transitions: readonly DiagramTransition[],
): DiagramLayout {
  const seen = new Set<string>();
  for (const stage of stagesInput) {
    if (seen.has(stage.id)) throw new DiagramLayoutError('DUPLICATE_STAGE', stage.key);
    seen.add(stage.id);
  }
  for (const transition of transitions) {
    if (!seen.has(transition.fromStageId) || !seen.has(transition.toStageId)) {
      throw new DiagramLayoutError('UNKNOWN_STAGE', transition.key);
    }
  }
  const stages = sortStages(stagesInput);
  if (stages.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const order = new Map(stages.map((stage, index) => [stage.id, index]));
  const { ranks, back } = rankStages(stages, transitions, order);

  const layerCount = Math.max(...ranks.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const stage of stages) layers[ranks.get(stage.id) ?? 0]?.push(stage.id);
  const forward = transitions.filter((transition) => !back.has(transition.id));
  orderLayers(layers, forward, order);

  const layerHeight = (size: number) => size * NODE_HEIGHT + Math.max(0, size - 1) * ORDER_GAP;
  const tallest = Math.max(...layers.map((layer) => layerHeight(layer.length)));
  const coordinates = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, rank) => {
    const top = PADDING + (tallest - layerHeight(layer.length)) / 2;
    layer.forEach((id, index) => {
      coordinates.set(id, {
        x: PADDING + rank * (NODE_WIDTH + RANK_GAP),
        y: top + index * (NODE_HEIGHT + ORDER_GAP),
      });
    });
  });

  const reachability = stageReachability(stages, transitions);
  const nodes = stages.map((stage) => {
    const point = coordinates.get(stage.id) ?? { x: PADDING, y: PADDING };
    return {
      stage,
      rank: ranks.get(stage.id) ?? 0,
      x: point.x,
      y: point.y,
      warning: reachability.get(stage.id) ?? null,
    };
  });

  const bottom = PADDING + tallest;
  const sortedTransitions = [...transitions].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key),
  );
  const parallel = new Map<string, number>();
  let lane = 0;
  const edges = sortedTransitions.map((transition): DiagramEdge => {
    const from = coordinates.get(transition.fromStageId) ?? { x: 0, y: 0 };
    const to = coordinates.get(transition.toStageId) ?? { x: 0, y: 0 };
    const pairKey = `${transition.fromStageId}>${transition.toStageId}`;
    const nth = parallel.get(pairKey) ?? 0;
    parallel.set(pairKey, nth + 1);
    const shift = (nth % 2 === 0 ? 1 : -1) * Math.ceil(nth / 2) * PARALLEL_OFFSET;
    if (back.has(transition.id)) {
      lane += 1;
      const x0 = from.x + NODE_WIDTH / 2 + shift;
      const x3 = to.x + NODE_WIDTH / 2 - shift;
      const y0 = from.y + NODE_HEIGHT;
      const y3 = to.y + NODE_HEIGHT;
      const control = bottom + lane * BACK_LANE;
      // Laço na própria etapa: abre lateralmente para a curva não degenerar.
      const spread = transition.fromStageId === transition.toStageId ? NODE_WIDTH / 3 : 0;
      return {
        transition,
        back: true,
        path: `M ${round(x0)} ${round(y0)} C ${round(x0 + spread)} ${round(control)}, ${round(
          x3 - spread,
        )} ${round(control)}, ${round(x3)} ${round(y3)}`,
        labelX: round((x0 + x3) / 2),
        labelY: round(0.125 * y0 + 0.75 * control + 0.125 * y3),
      };
    }
    const x0 = from.x + NODE_WIDTH;
    const y0 = from.y + NODE_HEIGHT / 2 + shift;
    const x3 = to.x;
    const y3 = to.y + NODE_HEIGHT / 2 + shift;
    const bend = Math.max(24, (x3 - x0) / 2);
    return {
      transition,
      back: false,
      path: `M ${round(x0)} ${round(y0)} C ${round(x0 + bend)} ${round(y0)}, ${round(
        x3 - bend,
      )} ${round(y3)}, ${round(x3)} ${round(y3)}`,
      labelX: round((x0 + x3) / 2),
      labelY: round((y0 + y3) / 2),
    };
  });

  return {
    nodes,
    edges,
    width: PADDING * 2 + layerCount * NODE_WIDTH + (layerCount - 1) * RANK_GAP,
    height: bottom + PADDING + lane * BACK_LANE,
  };
}

/**
 * `layoutDiagram` cronometrado e sem lançar: o hook de layout guarda o resultado (ou o erro, para a
 * lista alternativa) e a duração vai ao log `workflow.diagram_viewed`.
 */
export function timedLayout(
  stages: readonly DiagramStage[],
  transitions: readonly DiagramTransition[],
): { readonly layout: DiagramLayout | null; readonly error: unknown; readonly durationMs: number } {
  const startedAt = performance.now();
  try {
    const layout = layoutDiagram(stages, transitions);
    return { layout, error: null, durationMs: performance.now() - startedAt };
  } catch (error) {
    return { layout: null, error, durationMs: performance.now() - startedAt };
  }
}

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** "Ajustar à tela" (FA-02): o diagrama inteiro cabe no quadro, centralizado, sem passar de 100%. */
export function fitViewport(
  content: { readonly width: number; readonly height: number },
  frame: { readonly width: number; readonly height: number },
): Viewport {
  if (content.width <= 0 || content.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const zoom = clampZoom(Math.min(frame.width / content.width, frame.height / content.height, 1));
  return {
    x: round((frame.width - content.width * zoom) / 2),
    y: round((frame.height - content.height * zoom) / 2),
    zoom,
  };
}

/** Zoom mantendo fixo o ponto `(originX, originY)` do quadro (roda do mouse, botões +/−). */
export function zoomAround(
  viewport: Viewport,
  nextZoom: number,
  originX: number,
  originY: number,
): Viewport {
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / viewport.zoom;
  return {
    x: round(originX - (originX - viewport.x) * ratio),
    y: round(originY - (originY - viewport.y) * ratio),
    zoom,
  };
}

/** Centraliza o quadro no ponto `(contentX, contentY)` do diagrama (clique no minimapa). */
export function centerOn(
  viewport: Viewport,
  contentX: number,
  contentY: number,
  frame: { readonly width: number; readonly height: number },
): Viewport {
  return {
    x: round(frame.width / 2 - contentX * viewport.zoom),
    y: round(frame.height / 2 - contentY * viewport.zoom),
    zoom: viewport.zoom,
  };
}
