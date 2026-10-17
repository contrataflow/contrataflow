import type { Readable } from 'node:stream';

import { AntivirusUnavailableError } from '../application/files-ports.js';
import type { AntivirusPort } from '../application/files-ports.js';
import type { AntivirusResult } from '../domain/scan-verdict.js';

/*
 * Antivírus de teste (US-068): consome o stream inteiro, como o `clamd`, e acusa a assinatura de
 * teste EICAR (montada em tempo de execução nos testes — nunca gravada em disco). `failing` simula
 * o ClamAV fora do ar (Gherkin "[Falha de integração]").
 */

const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

export class FakeAntivirus implements AntivirusPort {
  readonly engine = 'fake';
  failing = false;
  scans = 0;

  async scan(stream: Readable): Promise<AntivirusResult> {
    if (this.failing) {
      stream.resume();
      throw new AntivirusUnavailableError();
    }
    this.scans += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('latin1').includes(EICAR_MARKER)
      ? { clean: false, signature: 'Eicar-Test-Signature' }
      : { clean: true };
  }

  version(): Promise<string | null> {
    return Promise.resolve('fake/1');
  }
}
