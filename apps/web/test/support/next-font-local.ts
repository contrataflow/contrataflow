// `next/font/local` é uma macro do compilador do Next: fora dele (Vitest) a função lança. O stub
// devolve a mesma forma do objeto gerado no build.
export default function localFont(): {
  className: string;
  variable: string;
  style: { fontFamily: string };
} {
  return {
    className: 'font-inter',
    variable: 'font-inter-variable',
    style: { fontFamily: 'Inter' },
  };
}
