import { GUIDE, globalReferences, memberPropertyName } from './utils.js';

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global', 'self']);
const TIMERS = new Set(['setTimeout', 'setInterval']);

/**
 * @param {import('estree').Node | undefined} node
 * @returns {boolean}
 */
function isStringLike(node) {
  return (
    node !== undefined &&
    ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral')
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export const noDynamicCode = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Proíbe eval, new Function e timers com string (execução dinâmica de código).',
    },
    schema: [],
    messages: {
      forbidden: `Uso proibido: {{api}}. Execução dinâmica de código não é permitida. ${GUIDE}`,
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string} api
     */
    const report = (node, api) => context.report({ node, messageId: 'forbidden', data: { api } });

    return {
      'Program:exit'(program) {
        const globalScope = context.sourceCode.getScope(program);
        for (const ref of globalReferences(globalScope, 'eval')) report(ref.identifier, 'eval');
        for (const ref of globalReferences(globalScope, 'Function')) {
          const parent = /** @type {import('estree').Node & { parent?: import('estree').Node }} */ (
            ref.identifier
          ).parent;
          if (
            (parent?.type === 'NewExpression' || parent?.type === 'CallExpression') &&
            parent.callee === ref.identifier
          ) {
            report(parent, parent.type === 'NewExpression' ? 'new Function' : 'Function()');
          }
        }
        for (const timer of TIMERS) {
          for (const ref of globalReferences(globalScope, timer)) {
            const parent =
              /** @type {import('estree').Node & { parent?: import('estree').Node }} */ (
                ref.identifier
              ).parent;
            if (
              parent?.type === 'CallExpression' &&
              parent.callee === ref.identifier &&
              isStringLike(parent.arguments[0])
            ) {
              report(parent, `${timer} com string`);
            }
          }
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          GLOBAL_OBJECTS.has(node.object.name) &&
          memberPropertyName(node) === 'eval'
        ) {
          report(node, `${node.object.name}.eval`);
        }
      },
    };
  },
};
