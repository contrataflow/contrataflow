/** Referência do guia citada em todas as mensagens (V-07). */
export const GUIDE = 'Veja CONTRIBUTING.md §Segurança.';

/**
 * Nome estático de uma propriedade (`obj.prop` ou `obj['prop']`); `null` se for dinâmico.
 * @param {import('estree').MemberExpression} node
 * @returns {string | null}
 */
export function memberPropertyName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }
  if (
    node.computed &&
    node.property.type === 'TemplateLiteral' &&
    node.property.expressions.length === 0
  ) {
    return node.property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Nome estático da chave de uma propriedade de objeto.
 * @param {import('estree').Property} node
 * @returns {string | null}
 */
export function propertyKeyName(node) {
  if (!node.computed && node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

/**
 * Referências a uma variável global não sombreada (ex.: `console`, `eval`).
 * @param {import('eslint').Scope.Scope} globalScope
 * @param {string} name
 * @returns {import('eslint').Scope.Reference[]}
 */
export function globalReferences(globalScope, name) {
  const declared = globalScope.set.get(name);
  const fromDeclared = declared ? declared.references : [];
  const unresolved = globalScope.through.filter((ref) => ref.identifier.name === name);
  return [...new Set([...fromDeclared, ...unresolved])];
}
