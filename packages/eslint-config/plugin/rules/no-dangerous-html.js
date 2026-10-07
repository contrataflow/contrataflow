import { GUIDE, propertyKeyName } from './utils.js';

const PROP = 'dangerouslySetInnerHTML';

/** @type {import('eslint').Rule.RuleModule} */
export const noDangerousHtml = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Proíbe dangerouslySetInnerHTML fora do componente de pré-visualização sanitizada (XSS).',
    },
    schema: [],
    messages: {
      forbidden: `Uso proibido: ${PROP}. Renderize HTML somente pelo componente de pré-visualização sanitizada (sanitized-html-preview.tsx). ${GUIDE}`,
    },
  },
  create(context) {
    return {
      /** @param {{ name: { type: string; name?: string } }} node */
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === PROP) {
          context.report({
            node: /** @type {import('estree').Node} */ (node),
            messageId: 'forbidden',
          });
        }
      },
      'ObjectExpression > Property'(node) {
        if (propertyKeyName(node) === PROP) context.report({ node, messageId: 'forbidden' });
      },
    };
  },
};
