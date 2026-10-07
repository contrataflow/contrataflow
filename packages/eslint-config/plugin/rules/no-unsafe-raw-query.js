import { GUIDE, memberPropertyName, propertyKeyName } from './utils.js';

const UNSAFE = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);

/** @type {import('eslint').Rule.RuleModule} */
export const noUnsafeRawQuery = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Proíbe $queryRawUnsafe/$executeRawUnsafe do Prisma (injeção de SQL e bypass do contexto de tenant).',
    },
    schema: [],
    messages: {
      forbidden: `Uso proibido: {{api}}. Use $queryRaw/$executeRaw parametrizado (tagged template) no repositório do módulo. ${GUIDE}`,
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = memberPropertyName(node);
        if (name !== null && UNSAFE.has(name)) {
          context.report({ node: node.property, messageId: 'forbidden', data: { api: name } });
        }
      },
      'ObjectPattern > Property'(node) {
        const name = propertyKeyName(node);
        if (name !== null && UNSAFE.has(name)) {
          context.report({ node: node.key, messageId: 'forbidden', data: { api: name } });
        }
      },
    };
  },
};
