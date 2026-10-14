import type { IconName } from './icons';

/*
 * Navegação do shell (architecture.md §8.2 · prototype/assets/app.js). Cada story de tela liga a
 * sua rota aqui; os menus por permissão (permissions.md §9) entram com a US-097. Rótulos no
 * namespace `shell` (next-intl).
 */

export interface NavItem {
  readonly href: string;
  readonly labelKey: 'dashboard' | 'tasks' | 'approvals' | 'processes' | 'suppliers' | 'example';
  readonly icon: IconName;
}

export const MAIN_NAV: readonly NavItem[] = [
  { href: '/painel', labelKey: 'dashboard', icon: 'dashboard' },
  { href: '/tarefas', labelKey: 'tasks', icon: 'inbox' },
  { href: '/aprovacoes', labelKey: 'approvals', icon: 'stamp' },
  { href: '/processos', labelKey: 'processes', icon: 'folder' },
  { href: '/fornecedores', labelKey: 'suppliers', icon: 'truck' },
  { href: '/exemplo', labelKey: 'example', icon: 'flask' },
];

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
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/admin/usuarios', labelKey: 'users' },
  { href: '/admin/perfis', labelKey: 'roles' },
  { href: '/admin/estrutura', labelKey: 'structure' },
  { href: '/admin/templates', labelKey: 'templates' },
  { href: '/admin/workflows', labelKey: 'workflows' },
  { href: '/admin/tipos-documento', labelKey: 'documentTypes' },
  { href: '/admin/catalogos', labelKey: 'catalogs' },
  { href: '/admin/calendario', labelKey: 'calendar' },
  { href: '/admin/configuracoes', labelKey: 'settings' },
];

/** Item ativo: rota exata ou subrota. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
