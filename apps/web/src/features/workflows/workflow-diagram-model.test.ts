import { describe, expect, it } from 'vitest';

import {
  centerOn,
  clampZoom,
  DiagramLayoutError,
  fitViewport,
  layoutDiagram,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_HEIGHT,
  NODE_WIDTH,
  stageReachability,
  zoomAround,
} from './workflow-diagram-model';
import type { DiagramStage, DiagramTransition } from './workflow-diagram-model';

/*
 * US-046 — modelo puro do diagrama: etapas → nós e transições → arestas (RN-WF-72), aviso de etapa
 * inalcançável/sem caminho ao fim (RN-WF-74, mesmo critério de WF_STAGE_UNREACHABLE e
 * WF_END_UNREACHABLE), layout em camadas recalculado sem posição persistida (RN-WF-71), falha de
 * layout para grafo malformado (FA-04) e o viewport (zoom, ajustar à tela, minimapa).
 */

const stage = (
  key: string,
  type: DiagramStage['type'],
  displayOrder: number,
  extra: Partial<DiagramStage> = {},
): DiagramStage => ({
  id: `s-${key}`,
  key,
  name: key,
  type,
  color: null,
  groupLabel: null,
  displayOrder,
  slaDays: null,
  slaType: 'BUSINESS',
  ...extra,
});

let sequence = 0;
const transition = (
  from: string,
  to: string,
  action: DiagramTransition['action'] = 'FORWARD',
  extra: Partial<DiagramTransition> = {},
): DiagramTransition => {
  sequence += 1;
  return {
    id: `t-${from}-${to}-${action}-${String(sequence)}`,
    key: `${from}_${to}_${action}`,
    name: `${from} → ${to}`,
    action,
    fromStageId: `s-${from}`,
    toStageId: `s-${to}`,
    isPrimary: action === 'FORWARD' || action === 'APPROVE' || action === 'COMPLETE',
    displayOrder: sequence,
    ...extra,
  };
};

/** "Fase preparatória — Lei 14.133/2021": 7 etapas, com aprovação e devolução. */
function preparatory() {
  const stages = [
    stage('ABERTURA', 'START', 0),
    stage('DFD', 'TASK', 1, { color: '#2563eb', slaDays: 5 }),
    stage('ETP', 'TASK', 2, { groupLabel: 'Planejamento' }),
    stage('PESQUISA_PRECOS', 'TASK', 3),
    stage('TR', 'TASK', 4),
    stage('APROVACAO', 'APPROVAL', 5),
    stage('CONCLUSAO', 'END', 6),
  ];
  const transitions = [
    transition('ABERTURA', 'DFD'),
    transition('DFD', 'ETP'),
    transition('ETP', 'PESQUISA_PRECOS'),
    transition('PESQUISA_PRECOS', 'TR'),
    transition('TR', 'APROVACAO'),
    transition('APROVACAO', 'CONCLUSAO', 'APPROVE'),
    transition('APROVACAO', 'TR', 'REJECT', { isPrimary: false }),
    transition('ETP', 'DFD', 'RETURN', { isPrimary: false }),
  ];
  return { stages, transitions };
}

const byKey = (layout: ReturnType<typeof layoutDiagram>, key: string) => {
  const node = layout.nodes.find((item) => item.stage.key === key);
  if (!node) throw new Error(`nó ${key} ausente`);
  return node;
};

describe('layoutDiagram (US-046 · RN-WF-71/72)', () => {
  it('[Sucesso] 7 etapas viram 7 nós e cada transição uma aresta; CONCLUSAO é END', () => {
    const { stages, transitions } = preparatory();
    const layout = layoutDiagram(stages, transitions);

    expect(layout.nodes).toHaveLength(7);
    expect(layout.edges).toHaveLength(transitions.length);
    expect(byKey(layout, 'CONCLUSAO').stage.type).toBe('END');
    expect(byKey(layout, 'DFD').stage.color).toBe('#2563eb');
    expect(byKey(layout, 'ETP').stage.groupLabel).toBe('Planejamento');
    expect(layout.nodes.every((node) => node.warning === null)).toBe(true);
  });

  it('camadas da esquerda para a direita no sentido do avanço; devolução e indeferimento por baixo', () => {
    const { stages, transitions } = preparatory();
    const layout = layoutDiagram(stages, transitions);
    const ranks = stages.map((item) => byKey(layout, item.key).rank);

    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(byKey(layout, 'DFD').x).toBeGreaterThan(byKey(layout, 'ABERTURA').x);
    const back = layout.edges.filter((edge) => edge.back).map((edge) => edge.transition.action);
    expect(back.sort()).toEqual(['REJECT', 'RETURN']);
    // As arestas de retorno passam abaixo dos nós, cada uma na sua faixa.
    const bottom = Math.max(...layout.nodes.map((node) => node.y + NODE_HEIGHT));
    for (const edge of layout.edges.filter((item) => item.back)) {
      expect(edge.labelY).toBeGreaterThan(bottom);
    }
    expect(layout.height).toBeGreaterThan(bottom);
    expect(layout.width).toBeGreaterThanOrEqual(7 * NODE_WIDTH);
  });

  it('é determinístico e independe da ordem de chegada das etapas (nada é persistido)', () => {
    const { stages, transitions } = preparatory();
    const first = layoutDiagram(stages, transitions);
    const again = layoutDiagram([...stages].reverse(), [...transitions].reverse());

    expect(again.nodes.map((node) => [node.stage.key, node.x, node.y])).toEqual(
      first.nodes.map((node) => [node.stage.key, node.x, node.y]),
    );
  });

  it('ramificação: as etapas da mesma camada empilham sem se sobrepor', () => {
    const stages = [
      stage('INICIO', 'START', 0),
      stage('A', 'TASK', 1),
      stage('B', 'TASK', 2),
      stage('C', 'TASK', 3),
      stage('FIM', 'END', 4),
    ];
    const transitions = [
      transition('INICIO', 'A'),
      transition('INICIO', 'B'),
      transition('INICIO', 'C'),
      transition('A', 'FIM', 'COMPLETE'),
      transition('B', 'FIM', 'COMPLETE'),
      transition('C', 'FIM', 'COMPLETE'),
    ];
    const layout = layoutDiagram(stages, transitions);
    const middle = ['A', 'B', 'C'].map((key) => byKey(layout, key));

    expect(new Set(middle.map((node) => node.rank))).toEqual(new Set([1]));
    const [top = 0, center = 0, bottom = 0] = middle.map((node) => node.y).sort((a, b) => a - b);
    expect(center - top).toBeGreaterThanOrEqual(NODE_HEIGHT);
    expect(bottom - center).toBeGreaterThanOrEqual(NODE_HEIGHT);
    // Início e fim centralizados na altura da camada mais alta.
    expect(byKey(layout, 'INICIO').y).toBe(byKey(layout, 'B').y);
    expect(byKey(layout, 'FIM').y).toBe(byKey(layout, 'B').y);
  });

  it('arestas paralelas entre o mesmo par não se sobrepõem; laço na própria etapa é de retorno', () => {
    const stages = [stage('INICIO', 'START', 0), stage('FIM', 'END', 1)];
    const transitions = [
      transition('INICIO', 'FIM'),
      transition('INICIO', 'FIM', 'COMPLETE'),
      transition('FIM', 'FIM', 'RETURN'),
    ];
    const layout = layoutDiagram(stages, transitions);
    const [first, second, loop] = layout.edges;

    expect(first?.labelY).not.toBe(second?.labelY);
    expect(loop?.back).toBe(true);
    expect(loop?.path).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it('[Validação] sem etapas: layout vazio', () => {
    expect(layoutDiagram([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('[Falha de integração] grafo malformado lança DiagramLayoutError (FA-04)', () => {
    const { stages, transitions } = preparatory();
    const orphan = { ...transition('TR', 'APROVACAO'), toStageId: 's-INEXISTENTE' };

    expect(() => layoutDiagram(stages, [...transitions, orphan])).toThrow(DiagramLayoutError);
    expect(() => layoutDiagram([...stages, ...stages.slice(0, 1)], transitions)).toThrow(
      expect.objectContaining({ reason: 'DUPLICATE_STAGE' }),
    );
  });

  it('30 etapas em cadeia com devoluções: layout calculado rápido e sem nós sobrepostos', () => {
    const stages = Array.from({ length: 30 }, (_, index) =>
      stage(`E${String(index)}`, index === 0 ? 'START' : index === 29 ? 'END' : 'TASK', index),
    );
    const transitions = stages
      .slice(1)
      .flatMap((item, index) => [
        transition(`E${String(index)}`, item.key),
        ...(index > 0 ? [transition(item.key, `E${String(index - 1)}`, 'RETURN')] : []),
      ]);
    const startedAt = performance.now();
    const layout = layoutDiagram(stages, transitions);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(new Set(layout.nodes.map((node) => `${String(node.x)}:${String(node.y)}`)).size).toBe(
      30,
    );
  });
});

describe('stageReachability (RN-WF-74)', () => {
  it('etapa sem entrada a partir do START e etapa sem caminho até o END recebem aviso', () => {
    const stages = [
      stage('INICIO', 'START', 0),
      stage('A', 'TASK', 1),
      stage('ILHA', 'TASK', 2),
      stage('BECO', 'TASK', 3),
      stage('FIM', 'END', 4),
    ];
    const transitions = [
      transition('INICIO', 'A'),
      transition('A', 'FIM', 'COMPLETE'),
      transition('A', 'BECO'),
      // Devolução não conta como avanço: BECO continua sem caminho até o fim.
      transition('BECO', 'A', 'RETURN'),
    ];
    const warnings = stageReachability(stages, transitions);

    expect(warnings.get('s-ILHA')).toEqual({ unreachable: true, noPathToEnd: true });
    expect(warnings.get('s-BECO')).toEqual({ unreachable: false, noPathToEnd: true });
    expect(warnings.has('s-A')).toBe(false);
    expect(warnings.has('s-INICIO')).toBe(false);
    const layout = layoutDiagram(stages, transitions);
    expect(byKey(layout, 'ILHA').warning?.unreachable).toBe(true);
  });

  it('sem START (ou sem END), o respectivo aviso não se aplica — como no validador da API', () => {
    const stages = [stage('A', 'TASK', 0), stage('B', 'TASK', 1)];
    expect(stageReachability(stages, [transition('A', 'B')]).size).toBe(0);

    const withStart = [stage('INICIO', 'START', 0), stage('B', 'TASK', 1)];
    expect(stageReachability(withStart, [transition('INICIO', 'B')]).size).toBe(0);
  });

  it('a aprovação avança pelo APPROVE; o REJECT não conta como caminho', () => {
    const stages = [
      stage('INICIO', 'START', 0),
      stage('APROVACAO', 'APPROVAL', 1),
      stage('REVISAO', 'TASK', 2),
      stage('FIM', 'END', 3),
    ];
    const transitions = [
      transition('INICIO', 'APROVACAO'),
      transition('APROVACAO', 'FIM', 'APPROVE'),
      transition('APROVACAO', 'REVISAO', 'REJECT'),
      transition('REVISAO', 'APROVACAO'),
    ];
    const warnings = stageReachability(stages, transitions);

    expect(warnings.get('s-REVISAO')).toEqual({ unreachable: true, noPathToEnd: false });
  });
});

describe('viewport (FA-02)', () => {
  it('ajustar à tela cabe o diagrama inteiro, centralizado, sem passar de 100%', () => {
    expect(fitViewport({ width: 2000, height: 500 }, { width: 1000, height: 500 })).toEqual({
      x: 0,
      y: 125,
      zoom: 0.5,
    });
    expect(fitViewport({ width: 400, height: 200 }, { width: 1000, height: 500 })).toEqual({
      x: 300,
      y: 150,
      zoom: 1,
    });
    expect(fitViewport({ width: 0, height: 0 }, { width: 1000, height: 500 })).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
    expect(fitViewport({ width: 100_000, height: 100 }, { width: 1000, height: 500 }).zoom).toBe(
      MIN_ZOOM,
    );
  });

  it('zoom mantém fixo o ponto de origem e respeita os limites', () => {
    const zoomed = zoomAround({ x: 0, y: 0, zoom: 1 }, 2, 100, 100);
    expect(zoomed).toEqual({ x: -100, y: -100, zoom: 2 });
    expect(zoomAround(zoomed, 10, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it('o minimapa centraliza o quadro no ponto clicado', () => {
    expect(centerOn({ x: 0, y: 0, zoom: 0.5 }, 400, 200, { width: 800, height: 400 })).toEqual({
      x: 200,
      y: 100,
      zoom: 0.5,
    });
  });
});
