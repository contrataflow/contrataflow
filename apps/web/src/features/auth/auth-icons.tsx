import type { SVGProps } from 'react';

/*
 * Ícones das telas de entrada e seleção de instituição (traço único, 24×24, decorativos —
 * `aria-hidden`). SVG próprio, sem biblioteca externa; o rótulo acessível fica sempre no
 * controle ou no texto ao lado.
 */

const PATHS = {
  fileText:
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.7.7l3.6 3.6A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2ZM14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8',
  zap: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14Z',
  chartColumn: 'M3 3v16a2 2 0 0 0 2 2h16M18 17V9m-5 8V5M8 17v-3',
  shieldCheck:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1ZM9 12l2 2 4-4',
  arrowRight: 'M5 12h14m-7-7 7 7-7 7',
  landmark:
    'M10 18v-7m1.12-8.8a2 2 0 0 1 1.76.01l7.87 3.84c.48.24.31.95-.22.95H3.47c-.53 0-.7-.71-.22-.95ZM14 18v-7m4 7v-7M3 22h18M6 18v-7',
  building:
    'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18ZM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2m12-13h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4m-4 4h4m-4 4h4m-4 4h4',
  chevronRight: 'm9 18 6-6-6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4m0-4h.01',
  alertCircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 8v4m0 4h.01',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m0 4h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:
    'M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20',
  smartphone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm5 16h.01',
  arrowLeft: 'M19 12H5m7 7-7-7 7-7',
} as const;

export type AuthIconName = keyof typeof PATHS;

export function AuthIcon({
  name,
  className = 'size-5',
  ...props
}: { readonly name: AuthIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
