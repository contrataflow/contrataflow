/*
 * Peças internas do módulo `files` usadas por specs de OUTROS módulos (ex.: rotas de documento
 * externo — US-064). Um spec em `src/modules/<x>/` não pode importar o interior de `files`
 * (DEC-041 · cross-module-only-via-facade); o suporte de teste fica fora dessa regra e reexporta
 * só o necessário para montar o cenário (antivírus falso, varredura, repositório em memória).
 */
export { AntivirusCircuit } from '#modules/files/application/antivirus-circuit.js';
export {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
} from '#modules/files/application/files-ports.js';
export { ScanFileJob } from '#modules/files/application/scan-file.job.js';
export { ScanDeferredError } from '#modules/files/application/scan-file.processor.js';
export { createAttachment } from '#modules/files/domain/attachment.js';
export { FakeAntivirus } from '#modules/files/infrastructure/fake-antivirus.js';
export type { InMemoryAttachmentRepository } from '#modules/files/infrastructure/in-memory-attachment.repository.js';
