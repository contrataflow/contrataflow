import localFont from 'next/font/local';

/**
 * Inter (DEC-185 · prd-6 §3), eixo de peso 400–800, auto-hospedada: o `next/font` serve o arquivo
 * em `/_next/static/media` (CSP `font-src 'self'`, sem host externo) e gera o `@font-face` com
 * métricas de fallback ajustadas. Subconjunto latino (cobre o pt-BR); licença OFL em `OFL.txt`.
 * A variável `--font-inter` alimenta o `--font-sans` do tema (`packages/ui/src/styles.css`).
 */
export const inter = localFont({
  src: './inter-latin-wght.woff2',
  weight: '400 800',
  style: 'normal',
  display: 'swap',
  // Sem `fallback`: a pilha de fallback (ui-sans-serif…) já está no `--font-sans` do tema.
  variable: '--font-inter',
});
