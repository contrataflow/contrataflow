'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type {
  WorkflowDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { logClientEvent } from '@/lib/client-log';
import { useTenantId } from '@/lib/session/session-context';

import { useIsDesktop } from './use-is-desktop';
import {
  centerOn,
  DiagramLayoutError,
  fitViewport,
  LARGE_DIAGRAM_STAGES,
  timedLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  zoomAround,
} from './workflow-diagram-model';
import type { DiagramEdge, DiagramLayout, DiagramNode, Viewport } from './workflow-diagram-model';
import { sortStages } from './workflow-editor-model';
import {
  fetchWorkflowVersion,
  fetchWorkflowVersions,
  workflowKeys,
  WORKFLOWS_PATH,
  WORKFLOWS_STALE_TIME_MS,
} from './workflows.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';
const ZOOM_STEP = 1.25;
/** Quadro antes da primeira medição (e no jsdom, sem `ResizeObserver`). */
const DEFAULT_FRAME = { width: 960, height: 448 };

const STAGE_ICONS: Readonly<Record<WorkflowStageDto['type'], string>> = {
  START: '▶',
  TASK: '■',
  APPROVAL: '✔',
  END: '◼',
};

type Selection =
  | { readonly kind: 'stage'; readonly id: string }
  | { readonly kind: 'transition'; readonly id: string };

/**
 * `useDiagramLayout` (RN-WF-71): recalcula o layout a cada versão carregada — nada é persistido.
 * Falha do layout (FA-04 · RN-WF-75) devolve `layout: null` e registra o aviso
 * `workflow.diagram_layout_failed`; sucesso registra `workflow.diagram_viewed` com a duração.
 */
export function useDiagramLayout(version: WorkflowVersionDetailDto | null): {
  readonly layout: DiagramLayout | null;
  readonly failed: boolean;
} {
  const result = useMemo(
    () => (version ? { version, ...timedLayout(version.stages, version.transitions) } : null),
    [version],
  );

  const logged = useRef<string | null>(null);
  useEffect(() => {
    if (!result) return;
    const id = `${result.version.id}:${String(result.version.version)}`;
    if (logged.current === id) return;
    logged.current = id;
    if (result.layout) {
      logClientEvent('info', 'workflow.diagram_viewed', {
        workflowVersionId: result.version.id,
        nodes: result.layout.nodes.length,
        edges: result.layout.edges.length,
        durationMs: Math.round(result.durationMs),
      });
    } else {
      logClientEvent('warn', 'workflow.diagram_layout_failed', {
        workflowVersionId: result.version.id,
        reason: result.error instanceof DiagramLayoutError ? result.error.reason : 'UNEXPECTED',
      });
    }
  }, [result]);

  return { layout: result?.layout ?? null, failed: result !== null && result.layout === null };
}

/**
 * Aba "Diagrama" do SCR-034 (US-046): somente leitura (RN-WF-70) — a versão do editor por padrão,
 * com o `VersionSwitcher` (WF-07) para ver qualquer outra (rascunho, publicada ou aposentada —
 * RN-WF-73); cada troca lê a versão em WF-09 e recalcula o desenho.
 */
export function WorkflowDiagramSection({
  workflow,
  defaultVersionId,
}: {
  readonly workflow: WorkflowDto;
  readonly defaultVersionId: string;
}) {
  const t = useTranslations('workflows.diagram');
  const tenantId = useTenantId();
  const ids = useId();
  const [versionId, setVersionId] = useState(defaultVersionId);
  const [selection, setSelection] = useState<Selection | null>(null);

  const history = useQuery({
    queryKey: workflowKeys.versions(tenantId, workflow.id),
    queryFn: async ({ signal }) => (await fetchWorkflowVersions(workflow.id, signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
  });
  const version = useQuery({
    queryKey: workflowKeys.version(tenantId, versionId),
    queryFn: async ({ signal }) => (await fetchWorkflowVersion(versionId, signal)).data,
    staleTime: WORKFLOWS_STALE_TIME_MS,
    throwOnError: false,
  });
  const data = version.data ?? null;
  const { layout, failed } = useDiagramLayout(data);

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`${ids}-title`} className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('hint')}</p>
        </div>
        {history.data && history.data.length > 0 ? (
          <VersionSwitcher
            items={history.data}
            value={versionId}
            onChange={(next) => {
              // Mesma versão: nada muda (sem nova leitura nem nós duplicados).
              if (next === versionId) return;
              setSelection(null);
              setVersionId(next);
            }}
          />
        ) : null}
      </div>

      {version.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-[28rem] w-full" />
        </div>
      ) : version.isError ? (
        <LoadFailure error={version.error} onRetry={() => void version.refetch()} />
      ) : data ? (
        <>
          {data.status === 'RETIRED' ? <Alert tone="warning" title={t('retired')} /> : null}
          {data.stages.length === 0 ? (
            <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
              {t('empty')}
            </p>
          ) : failed || !layout ? (
            <>
              <Alert tone="warning" title={t('layoutFailed')} />
              <DiagramFallbackList version={data} />
            </>
          ) : (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                <WorkflowDiagram
                  key={`${data.id}:${String(data.version)}`}
                  layout={layout}
                  selection={selection}
                  onSelect={setSelection}
                />
              </div>
              {selection ? (
                <DiagramDetails
                  version={data}
                  selection={selection}
                  onClose={() => {
                    setSelection(null);
                  }}
                />
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function LoadFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('workflows.diagram');
  if (isApiError(error) && error.status === 404) {
    return (
      <Alert tone="error" title={t('notFound')}>
        <Link href={WORKFLOWS_PATH} className="text-sm underline">
          {t('backToList')}
        </Link>
      </Alert>
    );
  }
  if (isApiError(error) && error.status === 403) {
    return <Alert tone="error" title={t('forbidden')} />;
  }
  return (
    <Alert tone="error" title={t('loadFailed')}>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </Alert>
  );
}

/** `VersionSwitcher` (passo 6): versões de WF-07, da mais recente para a mais antiga. */
function VersionSwitcher({
  items,
  value,
  onChange,
}: {
  readonly items: readonly WorkflowVersionSummaryDto[];
  readonly value: string;
  readonly onChange: (versionId: string) => void;
}) {
  const t = useTranslations('workflows');
  const ids = useId();
  return (
    <div className="flex w-full flex-col gap-1 sm:w-64">
      <label htmlFor={`${ids}-version`} className="text-sm">
        {t('diagram.version')}
      </label>
      <select
        id={`${ids}-version`}
        className={INPUT}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {t('diagram.versionOption', {
              number: item.versionNumber,
              status: t(`versions.status.${item.status}`),
            })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** SLA da etapa no mesmo formato da tabela do editor (US-043). */
function useSlaText(): (stage: Pick<WorkflowStageDto, 'slaDays' | 'slaType'>) => string | null {
  const t = useTranslations('workflows.editor.stages.sla');
  return (stage) => (stage.slaDays === null ? null : t(stage.slaType, { days: stage.slaDays }));
}

function useWarningText(): (node: DiagramNode) => string | null {
  const t = useTranslations('workflows.diagram.warnings');
  return (node) => {
    if (!node.warning) return null;
    if (node.warning.unreachable && node.warning.noPathToEnd) return t('both');
    return node.warning.unreachable ? t('unreachable') : t('noEnd');
  };
}

/**
 * `WorkflowDiagram`: o desenho num quadro com zoom (roda do mouse, botões), arrasto do fundo (pan)
 * e "Ajustar à tela". Nós e rótulos de aresta são botões — navegação por Tab, `aria-label`
 * descritivo — que só abrem os detalhes. Acima de 20 etapas (FA-02) abre ajustado e com minimapa;
 * abaixo de 768 px abre ajustado e com o minimapa oculto (pode ser mostrado).
 */
function WorkflowDiagram({
  layout,
  selection,
  onSelect,
}: {
  readonly layout: DiagramLayout;
  readonly selection: Selection | null;
  readonly onSelect: (selection: Selection) => void;
}) {
  const t = useTranslations('workflows');
  const ids = useId();
  const desktop = useIsDesktop();
  const large = layout.nodes.length > LARGE_DIAGRAM_STAGES;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(DEFAULT_FRAME);
  const fitOnOpen = large || !desktop;
  const [viewport, setViewport] = useState<Viewport>(() =>
    fitOnOpen ? fitViewport(layout, DEFAULT_FRAME) : { x: 0, y: 0, zoom: 1 },
  );
  const [minimap, setMinimap] = useState(large && desktop);
  const drag = useRef<{ x: number; y: number; origin: Viewport } | null>(null);
  const fitted = useRef(false);

  // Mede o quadro; na primeira medição, reajusta o "fit view" inicial ao tamanho real.
  useEffect(() => {
    const element = frameRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (size.width <= 0 || size.height <= 0) return;
      setFrame(size);
      if (!fitted.current) {
        fitted.current = true;
        if (fitOnOpen) setViewport(fitViewport(layout, size));
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [layout, fitOnOpen]);

  // Roda do mouse: listener nativo não passivo (o do React é passivo e não impede a rolagem).
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setViewport((current) =>
        zoomAround(
          current,
          current.zoom * factor,
          event.clientX - bounds.left,
          event.clientY - bounds.top,
        ),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    drag.current = { x: event.clientX, y: event.clientY, origin: viewport };
    // jsdom não implementa a captura de ponteiro.
    if ('setPointerCapture' in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setViewport({
      ...start.origin,
      x: start.origin.x + event.clientX - start.x,
      y: start.origin.y + event.clientY - start.y,
    });
  };
  const endDrag = () => {
    drag.current = null;
  };
  const zoomBy = (factor: number) => {
    setViewport((current) =>
      zoomAround(current, current.zoom * factor, frame.width / 2, frame.height / 2),
    );
  };

  const nameOf = (stageId: string) =>
    layout.nodes.find((node) => node.stage.id === stageId)?.stage.name ?? '';

  return (
    <div className="flex flex-col gap-2">
      <div
        role="toolbar"
        aria-label={t('diagram.controls.label')}
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            zoomBy(ZOOM_STEP);
          }}
        >
          {t('diagram.controls.zoomIn')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            zoomBy(1 / ZOOM_STEP);
          }}
        >
          {t('diagram.controls.zoomOut')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setViewport(fitViewport(layout, frame));
          }}
        >
          {t('diagram.controls.fit')}
        </Button>
        {large || !desktop ? (
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={minimap}
            onClick={() => {
              setMinimap((value) => !value);
            }}
          >
            {t('diagram.controls.minimap')}
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {t('diagram.controls.zoomLevel', { percent: Math.round(viewport.zoom * 100) })}
        </span>
      </div>
      <div
        ref={frameRef}
        data-testid="workflow-diagram-frame"
        className="relative h-[28rem] cursor-grab touch-none overflow-hidden rounded-card border border-border bg-background"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(viewport.zoom)})`,
          }}
        >
          <svg
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            className="absolute top-0 left-0 overflow-visible"
          >
            <defs>
              <marker
                id={`${ids}-arrow`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
              <marker
                id={`${ids}-arrow-primary`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <TransitionEdgePath
                key={edge.transition.id}
                edge={edge}
                markerId={`${ids}-arrow`}
                selected={selection?.kind === 'transition' && selection.id === edge.transition.id}
              />
            ))}
          </svg>
          <ul aria-label={t('diagram.stagesLabel')}>
            {layout.nodes.map((node) => (
              <li key={node.stage.id}>
                <StageNode
                  node={node}
                  selected={selection?.kind === 'stage' && selection.id === node.stage.id}
                  onSelect={() => {
                    onSelect({ kind: 'stage', id: node.stage.id });
                  }}
                />
              </li>
            ))}
          </ul>
          <ul aria-label={t('diagram.transitionsLabel')}>
            {layout.edges.map((edge) => (
              <li key={edge.transition.id}>
                <TransitionEdge
                  edge={edge}
                  fromName={nameOf(edge.transition.fromStageId)}
                  toName={nameOf(edge.transition.toStageId)}
                  selected={selection?.kind === 'transition' && selection.id === edge.transition.id}
                  onSelect={() => {
                    onSelect({ kind: 'transition', id: edge.transition.id });
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
        {minimap ? (
          <Minimap
            layout={layout}
            viewport={viewport}
            frame={frame}
            onCenter={(x, y) => {
              setViewport((current) => centerOn(current, x, y, frame));
            }}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('diagram.controls.hint')}</p>
    </div>
  );
}

/** `StageNode` (RN-WF-72): cor da etapa, ícone do tipo, nome, grupo e SLA; aviso de RN-WF-74. */
function StageNode({
  node,
  selected,
  onSelect,
}: {
  readonly node: DiagramNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const t = useTranslations('workflows');
  const { stage } = node;
  const slaOf = useSlaText();
  const warningOf = useWarningText();
  const sla = slaOf(stage);
  const warning = warningOf(node);
  const label = [
    t('diagram.node.label', { name: stage.name, type: t(`editor.stageTypes.${stage.type}`) }),
    stage.groupLabel ? t('diagram.node.group', { group: stage.groupLabel }) : null,
    sla ? t('diagram.node.sla', { sla }) : null,
    warning,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      data-stage-type={stage.type}
      className={`absolute flex flex-col items-start gap-0.5 overflow-hidden rounded-card border-2 border-l-8 bg-surface px-3 py-2 text-left shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        warning ? 'border-dashed border-warning' : selected ? 'border-primary' : 'border-border'
      } ${stage.type === 'APPROVAL' ? 'ring-2 ring-primary-soft' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        borderLeftColor: stage.color ?? undefined,
      }}
      onClick={onSelect}
    >
      <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-hidden="true">
        <span>{STAGE_ICONS[stage.type]}</span>
        <span className={stage.type === 'APPROVAL' ? 'font-semibold text-foreground' : ''}>
          {t(`editor.stageTypes.${stage.type}`)}
        </span>
        {warning ? <span className="text-foreground">⚠</span> : null}
      </span>
      <span className="w-full truncate text-sm font-medium" aria-hidden="true">
        {stage.name}
      </span>
      <span className="w-full truncate text-xs text-muted-foreground" aria-hidden="true">
        {[stage.groupLabel, sla].filter(Boolean).join(' · ') || ' '}
      </span>
    </button>
  );
}

function TransitionEdgePath({
  edge,
  markerId,
  selected,
}: {
  readonly edge: DiagramEdge;
  readonly markerId: string;
  readonly selected: boolean;
}) {
  const primary = edge.transition.isPrimary;
  return (
    <path
      d={edge.path}
      fill="none"
      data-primary={primary}
      className={primary || selected ? 'stroke-primary' : 'stroke-muted-foreground'}
      strokeWidth={primary || selected ? 2.5 : 1.5}
      strokeDasharray={edge.back || edge.transition.action === 'RETURN' ? '6 4' : undefined}
      markerEnd={`url(#${primary || selected ? `${markerId}-primary` : markerId})`}
    />
  );
}

/** `TransitionEdge`: rótulo clicável da aresta (o traço fica no SVG), com destaque de `isPrimary`. */
function TransitionEdge({
  edge,
  fromName,
  toName,
  selected,
  onSelect,
}: {
  readonly edge: DiagramEdge;
  readonly fromName: string;
  readonly toName: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const t = useTranslations('workflows');
  const { transition } = edge;
  const label = [
    t('diagram.edge.label', { name: transition.name, from: fromName, to: toName }),
    t(`editor.actions.${transition.action}`),
    transition.isPrimary ? t('diagram.edge.primary') : null,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      className={`absolute max-w-40 -translate-x-1/2 -translate-y-1/2 truncate rounded-control border bg-surface px-1.5 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-ring ${
        transition.isPrimary || selected
          ? 'border-primary font-semibold text-foreground'
          : 'border-border text-muted-foreground'
      }`}
      style={{ left: edge.labelX, top: edge.labelY }}
      onClick={onSelect}
    >
      <span aria-hidden="true">{transition.name}</span>
    </button>
  );
}

const MINIMAP_WIDTH = 176;
const MINIMAP_HEIGHT = 112;

function Minimap({
  layout,
  viewport,
  frame,
  onCenter,
}: {
  readonly layout: DiagramLayout;
  readonly viewport: Viewport;
  readonly frame: { readonly width: number; readonly height: number };
  readonly onCenter: (x: number, y: number) => void;
}) {
  const t = useTranslations('workflows.diagram');
  const scale = Math.min(MINIMAP_WIDTH / layout.width, MINIMAP_HEIGHT / layout.height);
  return (
    <button
      type="button"
      aria-label={t('minimap')}
      className="absolute right-2 bottom-2 rounded-control border border-border bg-surface p-1 shadow-card"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onCenter(
          (event.clientX - bounds.left - 4) / scale,
          (event.clientY - bounds.top - 4) / scale,
        );
      }}
    >
      <svg aria-hidden="true" width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT}>
        {layout.nodes.map((node) => (
          <rect
            key={node.stage.id}
            x={node.x * scale}
            y={node.y * scale}
            width={NODE_WIDTH * scale}
            height={NODE_HEIGHT * scale}
            className={node.warning ? 'fill-warning' : 'fill-muted-foreground'}
          />
        ))}
        <rect
          x={(-viewport.x / viewport.zoom) * scale}
          y={(-viewport.y / viewport.zoom) * scale}
          width={(frame.width / viewport.zoom) * scale}
          height={(frame.height / viewport.zoom) * scale}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.5}
        />
      </svg>
    </button>
  );
}

/** Detalhes só leitura do nó/aresta clicado (mesmos dados do painel da US-043, sem edição). */
function DiagramDetails({
  version,
  selection,
  onClose,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly selection: Selection;
  readonly onClose: () => void;
}) {
  const t = useTranslations('workflows');
  const ids = useId();
  const stage =
    selection.kind === 'stage' ? version.stages.find((item) => item.id === selection.id) : null;
  const transition =
    selection.kind === 'transition'
      ? version.transitions.find((item) => item.id === selection.id)
      : null;
  if (!stage && !transition) return null;
  const title = stage
    ? t('diagram.details.stageTitle', { name: stage.name })
    : t('diagram.details.transitionTitle', { name: transition?.name ?? '' });
  return (
    <aside
      aria-labelledby={`${ids}-details`}
      className="w-full rounded-card border border-border bg-surface p-4 shadow-card lg:w-80"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id={`${ids}-details`} className="font-medium">
          {title}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('diagram.details.close')}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('diagram.details.readOnly')}</p>
      {stage ? <StageDetails stage={stage} /> : null}
      {transition ? <TransitionDetails transition={transition} stages={version.stages} /> : null}
    </aside>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value && value !== '' ? value : '—'}</dd>
    </div>
  );
}

function StageDetails({ stage }: { readonly stage: WorkflowStageDto }) {
  const t = useTranslations('workflows');
  const slaOf = useSlaText();
  return (
    <dl className="mt-3 flex flex-col gap-2">
      <DetailRow label={t('editor.fields.key')} value={stage.key} />
      <DetailRow label={t('editor.fields.type')} value={t(`editor.stageTypes.${stage.type}`)} />
      <DetailRow label={t('diagram.details.group')} value={stage.groupLabel} />
      <DetailRow
        label={t('editor.fields.departmentResolution')}
        value={t(`editor.departmentResolutions.${stage.departmentResolution}`)}
      />
      <DetailRow
        label={t('editor.fields.assignmentPolicy')}
        value={t(`editor.assignmentPolicies.${stage.assignmentPolicy}`)}
      />
      {stage.type === 'APPROVAL' ? (
        <DetailRow
          label={t('editor.fields.approverType')}
          value={stage.approverType ? t(`editor.approverTypes.${stage.approverType}`) : null}
        />
      ) : null}
      <DetailRow label={t('diagram.details.sla')} value={slaOf(stage)} />
      <DetailRow
        label={t('editor.fields.documentTypeCodes')}
        value={stage.documentTypeCodes.join(', ')}
      />
      <DetailRow label={t('editor.fields.instructions')} value={stage.instructions} />
    </dl>
  );
}

function TransitionDetails({
  transition,
  stages,
}: {
  readonly transition: WorkflowTransitionDto;
  readonly stages: readonly WorkflowStageDto[];
}) {
  const t = useTranslations('workflows');
  const name = (id: string) => stages.find((stage) => stage.id === id)?.name ?? '';
  const yesNo = (value: boolean) => (value ? t('diagram.details.yes') : t('diagram.details.no'));
  return (
    <dl className="mt-3 flex flex-col gap-2">
      <DetailRow label={t('editor.transitionFields.key')} value={transition.key} />
      <DetailRow
        label={t('editor.transitionFields.action')}
        value={t(`editor.actions.${transition.action}`)}
      />
      <DetailRow
        label={t('diagram.details.route')}
        value={t('editor.transitions.route', {
          from: name(transition.fromStageId),
          to: name(transition.toStageId),
        })}
      />
      <DetailRow
        label={t('editor.transitionFields.isPrimary')}
        value={yesNo(transition.isPrimary)}
      />
      <DetailRow
        label={t('editor.transitionFields.requiresComment')}
        value={yesNo(transition.requiresComment)}
      />
      <DetailRow
        label={t('editor.transitionFields.allowDueDateOverride')}
        value={yesNo(transition.allowDueDateOverride)}
      />
    </dl>
  );
}

/** `DiagramFallbackList` (FA-04): etapas e transições em lista quando o layout falha. */
function DiagramFallbackList({ version }: { readonly version: WorkflowVersionDetailDto }) {
  const t = useTranslations('workflows');
  const ids = useId();
  const stages = sortStages(version.stages);
  const name = (id: string) => stages.find((stage) => stage.id === id)?.name ?? '?';
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-labelledby={`${ids}-stages`}>
        <h3 id={`${ids}-stages`} className="font-medium">
          {t('diagram.fallback.stages')}
        </h3>
        <ol className="mt-2 list-decimal pl-5 text-sm">
          {stages.map((stage) => (
            <li key={stage.id}>
              {stage.name}{' '}
              <span className="text-muted-foreground">
                ({t(`editor.stageTypes.${stage.type}`)})
              </span>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby={`${ids}-transitions`}>
        <h3 id={`${ids}-transitions`} className="font-medium">
          {t('diagram.fallback.transitions')}
        </h3>
        {version.transitions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('diagram.fallback.none')}</p>
        ) : (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {[...version.transitions]
              .sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key))
              .map((transition) => (
                <li key={transition.id}>
                  {transition.name}:{' '}
                  {t('editor.transitions.route', {
                    from: name(transition.fromStageId),
                    to: name(transition.toStageId),
                  })}
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
