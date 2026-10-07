import { GUIDE, globalReferences, memberPropertyName } from './utils.js';

/** @type {import('eslint').Rule.RuleModule} */
export const noConsole = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Proíbe console.* fora de tools/: logs passam pelo logger (redação de dados — DEC-138).',
    },
    schema: [],
    messages: {
      forbidden: `Uso proibido: console.{{method}}. Use o logger (Logger do NestJS / pino), que aplica redação de dados sensíveis. ${GUIDE}`,
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        const globalScope = context.sourceCode.getScope(program);
        for (const ref of globalReferences(globalScope, 'console')) {
          const parent = /** @type {import('estree').Node & { parent?: import('estree').Node }} */ (
            ref.identifier
          ).parent;
          const method =
            parent?.type === 'MemberExpression' ? (memberPropertyName(parent) ?? '*') : '*';
          context.report({ node: ref.identifier, messageId: 'forbidden', data: { method } });
        }
      },
    };
  },
};
