/**
 * Fábrica de regras que proíbem importar módulos fora das pastas autorizadas.
 * Cada proibição tem ID próprio para que a liberação por caminho (flat config `ignores`)
 * seja independente das demais.
 */

/**
 * @param {string} specifier
 * @param {readonly string[]} modules nomes exatos ou prefixos terminados em `/*`
 * @returns {boolean}
 */
export function matchesModule(specifier, modules) {
  return modules.some((pattern) =>
    pattern.endsWith('/*')
      ? specifier.startsWith(pattern.slice(0, -1))
      : specifier === pattern || specifier.startsWith(`${pattern}/`),
  );
}

/**
 * @param {{ description: string; modules: readonly string[]; message: string }} options
 * @returns {import('eslint').Rule.RuleModule}
 */
export function createRestrictedModuleRule({ description, modules, message }) {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages: { forbidden: message },
    },
    create(context) {
      /**
       * @param {import('estree').Node} node
       * @param {unknown} value
       */
      const check = (node, value) => {
        if (typeof value === 'string' && matchesModule(value, modules)) {
          context.report({ node, messageId: 'forbidden', data: { module: value } });
        }
      };

      return {
        ImportDeclaration(node) {
          check(node.source, node.source.value);
        },
        ExportNamedDeclaration(node) {
          if (node.source) check(node.source, node.source.value);
        },
        ExportAllDeclaration(node) {
          check(node.source, node.source.value);
        },
        ImportExpression(node) {
          if (node.source.type === 'Literal') check(node.source, node.source.value);
        },
        CallExpression(node) {
          const [first] = node.arguments;
          if (
            node.callee.type === 'Identifier' &&
            node.callee.name === 'require' &&
            first?.type === 'Literal'
          ) {
            check(first, first.value);
          }
        },
        /** @param {{ moduleReference: { type: string; expression?: { value?: unknown } } }} node */
        TSImportEqualsDeclaration(node) {
          if (node.moduleReference.type === 'TSExternalModuleReference') {
            check(
              /** @type {import('estree').Node} */ (node),
              node.moduleReference.expression?.value,
            );
          }
        },
      };
    },
  };
}
