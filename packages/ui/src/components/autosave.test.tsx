import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutosaveIndicator } from './autosave-indicator.js';
import { ConflictDialog } from './conflict-dialog.js';
import { HeaderConflictDialog } from './header-conflict-dialog.js';
import { RecoveredDraftBanner } from './recovered-draft-banner.js';
import { useAutosave } from '../autosave/use-autosave.js';

afterEach(cleanup);

const SAVED_AT = Date.UTC(2026, 9, 17, 17, 32);

describe('AutosaveIndicator (DEC-182 · acessibilidade)', () => {
  it('região aria-live polite com "Salvo às HH:mm" no fuso informado', () => {
    render(<AutosaveIndicator status="saved" savedAt={SAVED_AT} timeZone="America/Sao_Paulo" />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Salvo às 14:32')).toBeTruthy();
    // Compacto abaixo de 768 px (ícone + "Salvo").
    expect(screen.getByText('Salvo')).toBeTruthy();
  });

  it.each([
    ['dirty', 'Alterações não salvas'],
    ['saving', 'Salvando…'],
    ['offline', 'Sem conexão — alterações guardadas neste navegador'],
    ['blocked', 'Edição interrompida'],
  ] as const)('%s → "%s"', (status, text) => {
    render(<AutosaveIndicator status={status} savedAt={null} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('erro com a explicação; idle sem gravação não mostra nada', () => {
    const { rerender } = render(
      <AutosaveIndicator
        status="error"
        savedAt={null}
        message="O texto excede 50.000 caracteres."
      />,
    );
    expect(screen.getByText('Erro ao salvar: O texto excede 50.000 caracteres.')).toBeTruthy();
    rerender(<AutosaveIndicator status="idle" savedAt={null} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('ConflictDialog (FA-01/FA-10)', () => {
  it('três escolhas com textos completos; "Ver diferenças" marca inserido/removido em texto', async () => {
    const user = userEvent.setup();
    const onKeepMine = vi.fn();
    const onDiscardMine = vi.fn();
    render(
      <ConflictDialog
        open
        authorName="Bruno Carvalho"
        time="14:31"
        sectionTitle="Justificativa da necessidade"
        serverText={'Comum\nDo Bruno'}
        localText={'Comum\nDa Cláudia'}
        onKeepMine={onKeepMine}
        onDiscardMine={onDiscardMine}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Alterado por Bruno Carvalho às 14:31.');
    await user.click(screen.getByRole('button', { name: 'Ver diferenças' }));
    expect(screen.getByText('[removido]')).toBeTruthy();
    expect(screen.getByText('[inserido]')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Versão salva no servidor' }).textContent).toContain(
      'Do Bruno',
    );
    await user.click(screen.getByRole('button', { name: 'Manter a minha versão' }));
    await user.click(screen.getByRole('button', { name: 'Descartar a minha e recarregar' }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onDiscardMine).toHaveBeenCalledTimes(1);
  });

  it('a mesma pessoa em outra aba', () => {
    render(
      <ConflictDialog
        open
        isSelf
        authorName="Cláudia"
        time="14:31"
        serverText="a"
        localText="b"
        onKeepMine={() => undefined}
        onDiscardMine={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog').textContent).toContain('Você mesma, em outra aba, às 14:31.');
  });
});

describe('HeaderConflictDialog (FA-02)', () => {
  it('escolha por campo antes de salvar', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <HeaderConflictDialog
        open
        authorName="Bruno Carvalho"
        time="14:31"
        fields={[{ field: 'priority', label: 'Prioridade', mine: 'Alta', theirs: 'Urgente' }]}
        onResolve={onResolve}
      />,
    );
    const save = screen.getByRole('button', { name: 'Salvar escolhas' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('radio', { name: /Alteração de Bruno Carvalho às 14:31/ }));
    await user.click(save);
    expect(onResolve).toHaveBeenCalledWith({ priority: 'theirs' });
  });
});

describe('RecoveredDraftBanner (FA-08)', () => {
  it('Restaurar e Descartar', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(<RecoveredDraftBanner time="14:32" onRestore={onRestore} onDiscard={onDiscard} />);
    expect(screen.getByText('Recuperamos alterações não salvas de 14:32.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onRestore).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });
});

describe('useAutosave', () => {
  it('Ctrl+S grava já; beforeunload com pendência pede confirmação; modo leitura não grava', async () => {
    const save = vi.fn(() => Promise.resolve());
    const { result, unmount } = renderHook(() => useAutosave<string>({ save }));
    act(() => {
      result.current.change('S', 'texto');
    });
    expect(result.current.snapshot.status).toBe('dirty');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('S', 'texto', { resolution: null });
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.snapshot.status).toBe('saved');
    unmount();

    const readOnly = renderHook(() => useAutosave<string>({ save, enabled: false }));
    act(() => {
      readOnly.result.current.change('S', 'x');
    });
    expect(readOnly.result.current.hasPending()).toBe(false);
  });
});
