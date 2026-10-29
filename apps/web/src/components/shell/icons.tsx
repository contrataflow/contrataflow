import {
  Archive,
  Bell,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Download,
  FlaskConical,
  Folder,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Stamp,
  TriangleAlert,
  Truck,
  User,
  X,
} from '@contrataflow/ui';
import type { IconComponent, IconProps } from '@contrataflow/ui';

/*
 * Ícones do shell, do conjunto Lucide do design system (prd-5): traço único, 24×24, decorativos
 * (`aria-hidden`). O rótulo acessível fica sempre no controle que contém o ícone. Os nomes curtos
 * continuam os mesmos para as telas que já os usam.
 */

const ICONS = {
  menu: Menu,
  plus: Plus,
  close: X,
  search: Search,
  bell: Bell,
  building: Building2,
  chevronDown: ChevronDown,
  user: User,
  logout: LogOut,
  check: Check,
  download: Download,
  dashboard: LayoutDashboard,
  inbox: Inbox,
  stamp: Stamp,
  folder: Folder,
  truck: Truck,
  shield: ShieldCheck,
  flask: FlaskConical,
  message: MessageSquare,
  alert: TriangleAlert,
  clock: Clock,
  archive: Archive,
  settings: Settings,
} as const satisfies Record<string, IconComponent>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className = 'size-4',
  ...props
}: { readonly name: IconName } & Omit<IconProps, 'ref'>) {
  const Component = ICONS[name];
  return <Component aria-hidden="true" focusable="false" className={className} {...props} />;
}
