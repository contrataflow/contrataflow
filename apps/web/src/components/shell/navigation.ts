import type { IconName } from './icons';

/*
 * Navegação do shell (architecture.md §8.2 · prototype/assets/app.js). Cada story de tela liga a
 * sua rota aqui; os menus por permissão (permissions.md §9) entram com a US-097. Rótulos no
 * namespace `shell` (next-intl).
 */

/**
 * Blocos da barra lateral (prd-6 · §2.2, padrão do Microlegis): os itens do dia a dia sem rótulo
 * (`main`) e o grupo "Sistema" (`system`), com Auditoria e Administração recolhível.
 */
export type NavGroup = 'main' | 'system';

export interface NavItem {
  readonly href: string;
  readonly labelKey:
    'dashboard' | 'tasks' | 'approvals' | 'processes' | 'suppliers' | 'audit' | 'admin' | 'example';
  readonly icon: IconName;
  readonly group: NavGroup;
  /**
   * Permissão que dá acesso à área: o item só some quando a API confirma que o usuário NÃO a tem
   * (ME-03); enquanto a resposta não existe, a própria rota decide (RN-FND-92).
   */
  readonly permission?: string;
  /** Contador de pendências da caixa de tarefas (TSK-02) mostrado ao lado do rótulo. */
  readonly counter?: 'mine' | 'pendingApprovals';
}

export const MAIN_NAV: readonly NavItem[] = [
  // US-076: sem `DASHBOARD_VIEW` o menu some; a rota responde com o estado 403.
  {
    href: '/painel',
    labelKey: 'dashboard',
    icon: 'dashboard',
    group: 'main',
    permission: 'DASHBOARD_VIEW',
  },
  // US-056: sem `INBOX_VIEW` (caso excepcional) o menu some; a rota responde com o estado 403.
  {
    href: '/tarefas',
    labelKey: 'tasks',
    icon: 'inbox',
    group: 'main',
    permission: 'INBOX_VIEW',
    counter: 'mine',
  },
  {
    href: '/aprovacoes',
    labelKey: 'approvals',
    icon: 'stamp',
    group: 'main',
    counter: 'pendingApprovals',
  },
  { href: '/processos', labelKey: 'processes', icon: 'folder', group: 'main' },
  { href: '/fornecedores', labelKey: 'suppliers', icon: 'truck', group: 'main' },
  { href: '/exemplo', labelKey: 'example', icon: 'flask', group: 'main' },
  {
    href: '/auditoria',
    labelKey: 'audit',
    icon: 'shield',
    group: 'system',
    permission: 'AUDIT_VIEW',
  },
  { href: '/admin', labelKey: 'admin', icon: 'settings', group: 'system' },
];

export const NAV_GROUPS: readonly NavGroup[] = ['main', 'system'];

export interface AdminNavItem {
  readonly href: string;
  readonly labelKey:
    | 'users'
    | 'roles'
    | 'structure'
    | 'templates'
    | 'workflows'
    | 'documentTypes'
    | 'catalogs'
    | 'calendar'
    | 'settings';
  /**
   * Permissão que dá acesso à área (permissions.md §9): o item só some quando a API confirma que o
   * usuário NÃO a tem (ME-03); enquanto a resposta não existe, a própria rota decide (403).
   */
  readonly permission?: string;
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/admin/usuarios', labelKey: 'users' },
  { href: '/admin/perfis', labelKey: 'roles', permission: 'ROLE_VIEW' },
  { href: '/admin/estrutura', labelKey: 'structure' },
  { href: '/admin/templates', labelKey: 'templates', permission: 'TEMPLATE_VIEW' },
  { href: '/admin/workflows', labelKey: 'workflows', permission: 'WORKFLOW_VIEW' },
  { href: '/admin/tipos-documento', labelKey: 'documentTypes', permission: 'DOCUMENT_TYPE_MANAGE' },
  { href: '/admin/catalogos', labelKey: 'catalogs' },
  { href: '/admin/calendario', labelKey: 'calendar' },
  { href: '/admin/configuracoes', labelKey: 'settings' },
];

/** Raiz da administração: o item do menu que abre os subitens de `ADMIN_NAV`. */
export const ADMIN_PATH = '/admin';

/** Item ativo: rota exata ou subrota. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
