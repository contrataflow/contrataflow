import { NOTIFICATION_TYPES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_TEMPLATES,
  EmailTemplateRegistry,
  absoluteLink,
  escapeHtml,
} from './email-templates.js';
import { notificationContent } from '../notification-templates.js';

const BASE = 'https://app.contrataflow.test/';
const PROCESS = '/processos/0192f111-0000-7000-8000-0000000000c1';
const registry = new EmailTemplateRegistry(BASE);

describe('EmailTemplateRegistry (US-112 · RN-NTF-15)', () => {
  it('tem um template pt-BR para cada NotificationType do registro', () => {
    expect(Object.keys(EMAIL_TEMPLATES).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    for (const type of NOTIFICATION_TYPES) {
      const content = notificationContent(type, { groupCount: 1 });
      const email = registry.render({ type, ...content, link: PROCESS });
      expect(email, type).not.toBeNull();
      expect(email?.subject).toBe(`[ContrataFlow] ${content.title}`);
      expect(email?.text).toContain(content.body);
      expect(email?.text).toContain(
        `${EMAIL_TEMPLATES[type].action}: https://app.contrataflow.test${PROCESS}`,
      );
      expect(email?.html).toContain('<html lang="pt-BR">');
      expect(email?.html).toContain(`href="https://app.contrataflow.test${PROCESS}"`);
    }
  });

  it('[FA-03] tipo sem template devolve null', () => {
    expect(registry.has('TIPO_NOVO')).toBe(false);
    expect(registry.render({ type: 'TIPO_NOVO', title: 't', body: 'b', link: null })).toBeNull();
    const partial = new EmailTemplateRegistry(BASE, { MENTIONED: EMAIL_TEMPLATES.MENTIONED });
    expect(
      partial.render({ type: 'APPROVAL_REQUESTED', title: 't', body: 'b', link: null }),
    ).toBeNull();
  });

  it('[POL-09] nunca inclui valor monetário, mesmo se escapar da origem', () => {
    const email = registry.render({
      type: 'APPROVAL_REQUESTED',
      title: 'Aprovação de R$ 1.234.567,89',
      body: 'Valor estimado R$1234,00 aguardando.',
      link: PROCESS,
    });
    const all = `${email?.subject ?? ''}${email?.html ?? ''}${email?.text ?? ''}`;
    expect(all).not.toMatch(/1\.234\.567|1234,00/);
    expect(all).toContain('R$ •••');
  });

  it('escapa HTML e mantém o assunto em uma linha só (sem injeção de cabeçalho)', () => {
    const email = registry.render({
      type: 'MENTIONED',
      title: 'Olá <script>alert(1)</script>\r\nBcc: x@y.z',
      body: 'Corpo "com" <b>tags</b> & \'aspas\'',
      link: PROCESS,
    });
    expect(email?.subject).not.toMatch(/[\r\n]/);
    expect(email?.html).not.toContain('<script>');
    expect(email?.html).toContain('&lt;script&gt;');
    expect(email?.html).toContain('&quot;com&quot; &lt;b&gt;tags&lt;/b&gt; &amp; &#39;aspas&#39;');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('link relativo inválido ou ausente cai na central de notificações', () => {
    expect(absoluteLink('https://a.test', null)).toBe('https://a.test/notificacoes');
    expect(absoluteLink('https://a.test///', '//evil.test/x')).toBe('https://a.test/notificacoes');
    expect(absoluteLink('https://a.test', 'https://evil.test')).toBe('https://a.test/notificacoes');
    expect(absoluteLink('https://a.test/', '/processos/1')).toBe('https://a.test/processos/1');
  });

  it('[Acessibilidade] HTML com título, sem imagens e versão texto sempre presente', () => {
    const email = registry.render({
      type: 'ROLE_CHANGED',
      title: 'Perfil',
      body: 'Mudou.',
      link: null,
    });
    expect(email?.html).toContain('<title>Perfil</title>');
    expect(email?.html).not.toContain('<img');
    expect(email?.text.length).toBeGreaterThan(0);
    expect(email?.text).toContain('obrigatório');
  });
});
