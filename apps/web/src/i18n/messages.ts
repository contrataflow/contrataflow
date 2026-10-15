import auth from '../../messages/pt-BR/auth.json';
import calendar from '../../messages/pt-BR/calendar.json';
import catalogs from '../../messages/pt-BR/catalogs.json';
import documentTypes from '../../messages/pt-BR/documentTypes.json';
import errors from '../../messages/pt-BR/errors.json';
import example from '../../messages/pt-BR/example.json';
import implementationAssistant from '../../messages/pt-BR/implementationAssistant.json';
import organizations from '../../messages/pt-BR/organizations.json';
import permissions from '../../messages/pt-BR/permissions.json';
import settings from '../../messages/pt-BR/settings.json';
import shell from '../../messages/pt-BR/shell.json';

/** Locale único do MVP 1 (architecture.md §8.10 · RN-FND-95). */
export const LOCALE = 'pt-BR';

/** Fuso padrão até a instituição ativa ser conhecida (DEC-003). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Mensagens por namespace de feature (`messages/pt-BR/<namespace>.json`). */
export const messages = {
  auth,
  calendar,
  catalogs,
  documentTypes,
  errors,
  example,
  implementationAssistant,
  organizations,
  permissions,
  settings,
  shell,
};

export type Messages = typeof messages;
