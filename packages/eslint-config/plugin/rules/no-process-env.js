import { GUIDE, memberPropertyName } from './utils.js';

const PROCESS_MODULES = new Set(['process', 'node:process']);

/** @type {import('eslint').Rule.RuleModule} */
export const noProcessEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Proíbe process.env fora de src/config/**: a configuração é lida e validada em um único lugar (12-factor).',
    },
    schema: [],
    messages: {
      forbidden: `Uso proibido: process.env fora de src/config/**. Injete a configuração validada do módulo de configuração. ${GUIDE}`,
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'process' &&
          memberPropertyName(node) === 'env'
        ) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      'VariableDeclarator[init.type="Identifier"][init.name="process"] > ObjectPattern > Property'(
        node,
      ) {
        if (node.key.type === 'Identifier' && node.key.name === 'env') {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string' || !PROCESS_MODULES.has(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === 'env'
          ) {
            context.report({ node: specifier, messageId: 'forbidden' });
          }
        }
      },
    };
  },
};
