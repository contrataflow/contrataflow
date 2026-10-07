import { GUIDE } from './utils.js';

/** @type {import('eslint').Rule.RuleModule} */
export const requireServerOnly = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Exige import 'server-only' nos arquivos do BFF (tokens e sessão nunca chegam ao bundle do cliente).",
    },
    schema: [],
    messages: {
      missing: `Arquivos de apps/web/src/bff/** devem importar 'server-only' (o BFF nunca pode ir para o bundle do cliente). ${GUIDE}`,
    },
  },
  create(context) {
    return {
      Program(node) {
        const hasServerOnly = node.body.some(
          (statement) =>
            statement.type === 'ImportDeclaration' &&
            statement.source.value === 'server-only' &&
            statement.specifiers.length === 0,
        );
        if (!hasServerOnly) {
          context.report({ loc: { line: 1, column: 0 }, messageId: 'missing' });
        }
      },
    };
  },
};
