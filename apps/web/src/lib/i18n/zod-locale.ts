import { z } from 'zod';

/*
 * Mensagens de validação do Zod em pt-BR (architecture.md §8.6 · RN-FND-95): vale para todo
 * schema sem mensagem própria (os de packages/validation já trazem as suas). Efeito colateral
 * no carregamento do módulo — importado pelo documento raiz (cliente e servidor).
 */
z.config(z.locales.ptBR());

export const ZOD_LOCALE = 'pt-BR';
