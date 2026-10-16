import auth from '../../messages/pt-BR/auth.json';
import calendar from '../../messages/pt-BR/calendar.json';
import catalogs from '../../messages/pt-BR/catalogs.json';
import departments from '../../messages/pt-BR/departments.json';
import documentTypes from '../../messages/pt-BR/documentTypes.json';
import errors from '../../messages/pt-BR/errors.json';
import example from '../../messages/pt-BR/example.json';
import implementationAssistant from '../../messages/pt-BR/implementationAssistant.json';
import notifications from '../../messages/pt-BR/notifications.json';
import organizations from '../../messages/pt-BR/organizations.json';
import permissions from '../../messages/pt-BR/permissions.json';
import processActions from '../../messages/pt-BR/processActions.json';
import roles from '../../messages/pt-BR/roles.json';
import settings from '../../messages/pt-BR/settings.json';
import shell from '../../messages/pt-BR/shell.json';
import templates from '../../messages/pt-BR/templates.json';
import users from '../../messages/pt-BR/users.json';

/** Locale único do MVP 1 (architecture.md §8.10 · RN-FND-95). */
export const LOCALE = 'pt-BR';

/** Fuso padrão até a instituição ativa ser conhecida (DEC-003). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Mensagens por namespace de feature (`messages/pt-BR/<namespace>.json`). */
export const messages = {
  auth,
  calendar,
  catalogs,
  departments,
  documentTypes,
  errors,
  example,
  implementationAssistant,
  notifications,
  organizations,
  permissions,
  processActions,
  roles,
  settings,
  shell,
  templates,
  users,
};

export type Messages = typeof messages;
