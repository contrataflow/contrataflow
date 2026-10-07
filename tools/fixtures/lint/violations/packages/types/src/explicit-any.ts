// Violação: @typescript-eslint/no-explicit-any (RN-FND-03).
export function identity(value: any): unknown {
  return value;
}
