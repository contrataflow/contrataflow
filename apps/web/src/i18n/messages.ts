import auth from '../../messages/pt-BR/auth.json';
import documentTypes from '../../messages/pt-BR/documentTypes.json';
import errors from '../../messages/pt-BR/errors.json';
import example from '../../messages/pt-BR/example.json';
import implementationAssistant from '../../messages/pt-BR/implementationAssistant.json';
import permissions from '../../messages/pt-BR/permissions.json';
import shell from '../../messages/pt-BR/shell.json';

/** Locale único do MVP 1 (architecture.md §8.10 · RN-FND-95). */
export const LOCALE = 'pt-BR';

/** Fuso padrão até a instituição ativa ser conhecida (DEC-003). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Mensagens por namespace de feature (`messages/pt-BR/<namespace>.json`). */
export const messages = {
  auth,
  documentTypes,
  errors,
  example,
  implementationAssistant,
  permissions,
  shell,
};

export type Messages = typeof messages;
