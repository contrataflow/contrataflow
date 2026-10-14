import type { ReactNode } from 'react';

/** Grupo `(auth)`: layout mínimo, sem shell (architecture.md §8.2 · RN-FND-87). */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-4">
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-control bg-primary text-sm font-bold text-primary-foreground"
        >
          CF
        </span>
        <span className="text-base font-semibold tracking-tight">ContrataFlow</span>
      </header>
      <main id="conteudo" className="flex flex-1 justify-center px-4">
        {children}
      </main>
    </div>
  );
}
