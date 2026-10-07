// Violação: contrataflow/no-console (log sem redação de dados sensíveis).
export function logProcess(processId: string): void {
  console.log('processo criado', processId);
}
