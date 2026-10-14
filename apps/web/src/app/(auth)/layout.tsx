import type { ReactNode } from 'react';

import { AuthChrome } from '@/features/auth/auth-chrome';

/** Grupo `(auth)`: layout mínimo, sem shell (architecture.md §8.2 · RN-FND-87). */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return <AuthChrome>{children}</AuthChrome>;
}
