// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeSessionEvents } from '@/lib/session/session-channel';
import { jsonResponse, shellSession, TENANT_B, IntlProvider } from '@test/support/render';

import { TenantSelection } from './tenant-selection';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSelection(activeTenantId: string | null) {
  const assign = vi.fn();
  vi.stubGlobal('location', { href: window.location.href, assign });
  render(
    <IntlProvider>
      <TenantSelection memberships={shellSession().memberships} activeTenantId={activeTenantId} />
    </IntlProvider>,
  );
  return assign;
}

describe('seleção de instituição (FA-02)', () => {
  it('troca a instituição, avisa as abas e vai ao início', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    const stop = subscribeSessionEvents((event) => events.push(event));
    const assign = renderSelection(null);
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/exemplo');
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-CF-Request')).toBe('1');
    await waitFor(() => {
      expect(events).toEqual([{ type: 'tenant-switched', tenantId: TENANT_B.id }]);
    });
    stop();
  });

  it('falha mostra o aviso e permite tentar de novo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const assign = renderSelection(TENANT_B.id);
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura B' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});
