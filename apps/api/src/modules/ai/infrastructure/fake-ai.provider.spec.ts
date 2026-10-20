import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from './fake-ai.provider.js';
import { UnavailableAiProvider } from './unavailable-ai.provider.js';
import {
  contractRequest,
  describeAiProviderContract,
} from '../../../../test/support/ai-provider-contract.js';
import { AiProviderError } from '../application/ai-provider.port.js';

describeAiProviderContract({
  name: 'FakeAiProvider',
  make: () => new FakeAiProvider(),
  failing: (kind) => new FakeAiProvider().enqueue({ kind: 'error', error: kind }),
});

describe('FakeAiProvider (tests.md §3.10)', () => {
  it('é determinístico: o mesmo pedido produz a mesma resposta', async () => {
    const first = await new FakeAiProvider().generate(contractRequest());
    const second = await new FakeAiProvider().generate(contractRequest());
    expect(first).toEqual(second);
    expect(first.output).toEqual({
      sections: [
        {
          sectionKey: 'NECESSIDADE',
          blocks: [{ type: 'paragraph', text: expect.stringContaining('[a confirmar') as unknown }],
        },
      ],
    });
  });

  it('escolhe a fixture pelo contextHash; sem correspondência, a padrão da promptKey', async () => {
    const provider = new FakeAiProvider([
      { promptKey: 'contract.draft', output: { sections: [], tag: 'padrão' } },
      {
        promptKey: 'contract.draft',
        contextHash: 'c'.repeat(64),
        output: { sections: [], tag: 'exata' },
      },
    ]);
    expect((await provider.generate(contractRequest())).output).toMatchObject({ tag: 'exata' });
    const other = contractRequest({
      metadata: { ...contractRequest().metadata, contextHash: 'd'.repeat(64) },
    });
    expect((await provider.generate(other)).output).toMatchObject({ tag: 'padrão' });
  });

  it('roteiro: saída, erro com uso, espera controlada e espera até o cancelamento', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new FakeAiProvider().enqueue(
      { kind: 'error', error: 'UNAVAILABLE', usage: { inputTokens: 5, outputTokens: 0 } },
      {
        kind: 'wait',
        until: gate,
        then: { kind: 'output', output: 'texto', finishReason: 'length' },
      },
      { kind: 'hang' },
    );
    await expect(provider.generate(contractRequest())).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      usage: { inputTokens: 5, outputTokens: 0 },
    });
    const waiting = provider.generate(contractRequest());
    release();
    await expect(waiting).resolves.toMatchObject({ output: 'texto', finishReason: 'length' });
    const controller = new AbortController();
    const hanging = provider.generate(contractRequest({ signal: controller.signal }));
    controller.abort();
    await expect(hanging).rejects.toBeInstanceOf(AiProviderError);
    expect(provider.calls).toHaveLength(3);
    provider.reset();
    expect(provider.calls).toHaveLength(0);
  });

  it('carrega as fixtures de <dir>/<promptKey>/*.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-ai-'));
    mkdirSync(join(dir, 'draft.dfd'));
    writeFileSync(
      join(dir, 'draft.dfd', 'padrao.json'),
      JSON.stringify({ output: { sections: [] } }),
    );
    writeFileSync(
      join(dir, 'draft.dfd', 'exata.json'),
      JSON.stringify({ contextHash: 'e'.repeat(64), output: { sections: [] } }),
    );
    writeFileSync(join(dir, 'draft.dfd', 'leia-me.txt'), 'ignorado');
    writeFileSync(join(dir, 'solto.json'), '{}');
    expect(loadFakeAiFixtures(dir)).toEqual([
      { promptKey: 'draft.dfd', contextHash: 'e'.repeat(64), output: { sections: [] } },
      { promptKey: 'draft.dfd', output: { sections: [] } },
    ]);
    expect(loadFakeAiFixtures(join(dir, 'inexistente'))).toEqual([]);
    expect(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR).length).toBeGreaterThan(0);
  });

  it('AI_PROVIDER=none: indisponível para todos', async () => {
    await expect(new UnavailableAiProvider().generate()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
    });
  });
});
