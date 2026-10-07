// Violação: contrataflow/no-dynamic-code (eval e new Function).
export function evaluate(expression: string): unknown {
  return eval(expression);
}

export const compile = (body: string): unknown => new Function('input', body);
