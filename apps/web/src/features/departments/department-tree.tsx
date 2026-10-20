'use client';

import { Button, cx } from '@contrataflow/ui';
import type { DepartmentDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';

import { buildTree, canDropOn, typeLabel, visibleNodes } from './department-tree-model';
import type { DepartmentNode, StructureLabels } from './department-tree-model';

export type DepartmentAction = 'addChild' | 'edit' | 'move' | 'deactivate' | 'activate' | 'delete';

export interface DepartmentTreeProps {
  readonly departments: readonly DepartmentDto[];
  readonly organizationName: string;
  readonly labels: StructureLabels;
  /** `DEPARTMENT_MANAGE`: ações e arrastar só aparecem com a permissão (a API decide). */
  readonly canManage: boolean;
  /** Unidade com movimentação em andamento (indicador). */
  readonly movingId: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onAction: (action: DepartmentAction, department: DepartmentDto) => void;
  /** Soltar `dragged` sobre `target` (`null` = primeiro nível do órgão). */
  readonly onMove: (dragged: DepartmentDto, target: DepartmentDto | null) => void;
}

/**
 * `DepartmentTree` (SCR-032 · US-102): árvore ARIA (`tree`/`treeitem`/`group`) com foco itinerante
 * — setas para cima/baixo entre os nós visíveis, direita expande ou entra no primeiro filho,
 * esquerda recolhe ou volta ao pai, Home/End, Enter abre a edição (ou expande, sem permissão).
 * Arrastar e soltar move a unidade (DEP-06); "Mover para…" é a alternativa acessível.
 */
export function DepartmentTree({
  departments,
  organizationName,
  labels,
  canManage,
  movingId,
  expanded,
  onToggle,
  onAction,
  onMove,
}: DepartmentTreeProps) {
  const t = useTranslations('departments');
  const tree = useMemo(() => buildTree(departments), [departments]);
  const visible = useMemo(() => visibleNodes(tree, expanded), [tree, expanded]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragged, setDragged] = useState<DepartmentDto | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const activeId = visible.some((node) => node.department.id === focusedId)
    ? focusedId
    : (visible[0]?.department.id ?? null);

  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    items.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const node = visible[index];
    if (!node || event.target !== event.currentTarget) return;
    const id = node.department.id;
    switch (event.key) {
      case 'ArrowDown':
        focus(visible[index + 1]?.department.id);
        break;
      case 'ArrowUp':
        focus(visible[index - 1]?.department.id);
        break;
      case 'Home':
        focus(visible[0]?.department.id);
        break;
      case 'End':
        focus(visible.at(-1)?.department.id);
        break;
      case 'ArrowRight':
        if (node.hasChildren && !node.expanded) onToggle(id);
        else if (node.hasChildren) focus(visible[index + 1]?.department.id);
        break;
      case 'ArrowLeft':
        if (node.hasChildren && node.expanded) onToggle(id);
        else focus(node.parentId ?? undefined);
        break;
      case 'Enter':
        if (canManage) onAction('edit', node.department);
        else if (node.hasChildren) onToggle(id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const dragProps = (department: DepartmentDto) =>
    canManage
      ? {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', department.id);
            setDragged(department);
          },
          onDragEnd: () => {
            setDragged(null);
            setDropTarget(null);
          },
          onDragOver: (event: DragEvent) => {
            if (dragged && canDropOn(dragged, department)) {
              event.preventDefault();
              setDropTarget(department.id);
            }
          },
          onDragLeave: () => {
            setDropTarget((current) => (current === department.id ? null : current));
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            if (dragged && canDropOn(dragged, department)) onMove(dragged, department);
            setDragged(null);
            setDropTarget(null);
          },
        }
      : {};

  const renderNodes = (nodes: readonly DepartmentNode[], level: number) =>
    nodes.map((node, position) => {
      const { department } = node;
      const index = visible.findIndex((item) => item.department.id === department.id);
      const isExpanded = expanded.has(department.id);
      const hasChildren = node.children.length > 0;
      const type = typeLabel(department.type, labels, (value) => t(`types.${value}`));
      return (
        <div
          key={department.id}
          role="none"
          className={cx(movingId === department.id && 'opacity-60')}
        >
          <div
            ref={(element) => {
              if (element) items.current.set(department.id, element);
              else items.current.delete(department.id);
            }}
            role="treeitem"
            aria-label={[department.name, type, department.isActive ? null : t('tree.inactive')]
              .filter(Boolean)
              .join(', ')}
            aria-level={level}
            aria-posinset={position + 1}
            aria-setsize={nodes.length}
            aria-expanded={hasChildren ? isExpanded : undefined}
            aria-selected={activeId === department.id}
            aria-busy={movingId === department.id || undefined}
            aria-owns={hasChildren && isExpanded ? `group-${department.id}` : undefined}
            tabIndex={activeId === department.id ? 0 : -1}
            onFocus={() => {
              setFocusedId(department.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={cx(
              'flex flex-wrap items-center gap-2 rounded-control px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-primary',
              dropTarget === department.id && 'bg-primary/10 ring-2 ring-primary',
              !department.isActive && 'text-muted-foreground',
            )}
            style={{ paddingLeft: `${(level - 1) * 1.25 + 0.5}rem` }}
            {...dragProps(department)}
          >
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t(isExpanded ? 'tree.collapse' : 'tree.expand', {
                  name: department.name,
                })}
                className="inline-flex size-6 items-center justify-center rounded-control text-xs hover:bg-muted"
                onClick={() => {
                  onToggle(department.id);
                }}
              >
                <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span className="inline-block size-6" aria-hidden="true" />
            )}
            <span className="font-medium">{department.name}</span>
            {department.acronym ? (
              <span className="font-mono text-xs text-muted-foreground">{department.acronym}</span>
            ) : null}
            <span className="rounded-control bg-muted px-2 py-0.5 text-xs">{type}</span>
            {department.isActive ? null : (
              <span className="rounded-control bg-muted px-2 py-0.5 text-xs">
                {t('tree.inactive')}
              </span>
            )}
            {movingId === department.id ? (
              <span className="text-xs" role="status">
                {t('moving', { name: department.name })}
              </span>
            ) : null}
            {canManage ? (
              <span className="ml-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  // Uma parada de Tab por nó: só o nó ativo expõe o botão de ações.
                  tabIndex={activeId === department.id ? 0 : -1}
                  aria-expanded={menuFor === department.id}
                  aria-label={t('tree.actions', { name: department.name })}
                  onClick={() => {
                    setMenuFor((current) => (current === department.id ? null : department.id));
                  }}
                >
                  ⋯
                </Button>
              </span>
            ) : null}
          </div>
          {canManage && menuFor === department.id ? (
            <div
              role="group"
              aria-label={t('tree.actions', { name: department.name })}
              className="my-1 flex flex-wrap gap-2"
              style={{ paddingLeft: `${level * 1.25 + 0.5}rem` }}
            >
              {(
                [
                  ...(department.isActive ? (['addChild'] as const) : []),
                  'edit',
                  'move',
                  department.isActive ? 'deactivate' : 'activate',
                  'delete',
                ] as const
              ).map((action) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === 'delete' ? 'destructive' : 'secondary'}
                  onClick={() => {
                    setMenuFor(null);
                    onAction(action, department);
                  }}
                >
                  {t(`actions.${action}`)}
                </Button>
              ))}
            </div>
          ) : null}
          {hasChildren && isExpanded ? (
            <div role="group" id={`group-${department.id}`}>
              {renderNodes(node.children, level + 1)}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <div className="flex flex-col gap-2">
      {canManage ? <p className="text-sm text-muted-foreground">{t('dropHint')}</p> : null}
      <div
        role="tree"
        aria-label={t('tree.label', { organization: organizationName })}
        className="rounded-card border border-border bg-surface p-2 shadow-card"
      >
        {renderNodes(tree, 1)}
      </div>
      {/* Abaixo da árvore: aparecer durante o arrasto não desloca os nós (alvos) acima. */}
      {canManage && dragged && dragged.parentId !== null ? (
        // Alvo só de arrastar: a alternativa por teclado é "Mover para…" (primeiro nível).
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div
          className={cx(
            'rounded-card border border-dashed border-border p-3 text-center text-sm',
            dropTarget === 'root' && 'bg-primary/10 ring-2 ring-primary',
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDropTarget('root');
          }}
          onDrop={(event) => {
            event.preventDefault();
            onMove(dragged, null);
            setDragged(null);
            setDropTarget(null);
          }}
        >
          {t('dropRoot')}
        </div>
      ) : null}
    </div>
  );
}
