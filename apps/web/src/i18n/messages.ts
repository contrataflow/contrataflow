import ai from '../../messages/pt-BR/ai.json';
import attachments from '../../messages/pt-BR/attachments.json';
import audit from '../../messages/pt-BR/audit.json';
import auth from '../../messages/pt-BR/auth.json';
import calendar from '../../messages/pt-BR/calendar.json';
import catalogs from '../../messages/pt-BR/catalogs.json';
import departments from '../../messages/pt-BR/departments.json';
import documents from '../../messages/pt-BR/documents.json';
import documentTypes from '../../messages/pt-BR/documentTypes.json';
import errors from '../../messages/pt-BR/errors.json';
import example from '../../messages/pt-BR/example.json';
import implementationAssistant from '../../messages/pt-BR/implementationAssistant.json';
import notificationPreferences from '../../messages/pt-BR/notificationPreferences.json';
import notifications from '../../messages/pt-BR/notifications.json';
import organizations from '../../messages/pt-BR/organizations.json';
import permissions from '../../messages/pt-BR/permissions.json';
import processActions from '../../messages/pt-BR/processActions.json';
import processes from '../../messages/pt-BR/processes.json';
import processItems from '../../messages/pt-BR/processItems.json';
import processList from '../../messages/pt-BR/processList.json';
import processParticipants from '../../messages/pt-BR/processParticipants.json';
import profile from '../../messages/pt-BR/profile.json';
import risks from '../../messages/pt-BR/risks.json';
import roles from '../../messages/pt-BR/roles.json';
import settings from '../../messages/pt-BR/settings.json';
import shell from '../../messages/pt-BR/shell.json';
import suppliers from '../../messages/pt-BR/suppliers.json';
import templates from '../../messages/pt-BR/templates.json';
import timeline from '../../messages/pt-BR/timeline.json';
import users from '../../messages/pt-BR/users.json';
import workflows from '../../messages/pt-BR/workflows.json';

/** Locale único do MVP 1 (architecture.md §8.10 · RN-FND-95). */
export const LOCALE = 'pt-BR';

/** Fuso padrão até a instituição ativa ser conhecida (DEC-003). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Mensagens por namespace de feature (`messages/pt-BR/<namespace>.json`). */
export const messages = {
  ai,
  attachments,
  audit,
  auth,
  calendar,
  catalogs,
  departments,
  documents,
  documentTypes,
  errors,
  example,
  implementationAssistant,
  notificationPreferences,
  notifications,
  organizations,
  permissions,
  processActions,
  processList,
  processes,
  processItems,
  processParticipants,
  profile,
  risks,
  roles,
  settings,
  shell,
  suppliers,
  templates,
  timeline,
  users,
  workflows,
};

export type Messages = typeof messages;
