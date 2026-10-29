import { Progress } from '@contrataflow/ui';

/**
 * Barra indeterminada da verificação de segurança. O `Progress` do kit, sem `value`, deixa o
 * indicador com largura 0; aqui o indicador é preenchido e pulsa (o kit não é alterado).
 */
export function ScanProgress({ label }: { readonly label: string }) {
  return (
    <Progress
      aria-label={label}
      className="[&>div]:!w-full [&>div]:animate-pulse motion-reduce:[&>div]:animate-none"
    />
  );
}
