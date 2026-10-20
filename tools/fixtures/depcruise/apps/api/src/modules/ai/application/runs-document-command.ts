// Violação: ai-read-only (o ai nunca executa comando de outro módulo — regra D9 · DEC-079).
import { CancelDocumentCommand } from '../../document/application/document.commands.js';

export const command = CancelDocumentCommand;
