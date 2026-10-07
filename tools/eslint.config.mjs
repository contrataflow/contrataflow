import { node } from '@contrataflow/eslint-config/node';

export default [
  // Fixtures de violação são analisadas pelos próprios testes, com configuração dedicada.
  { ignores: ['fixtures/**', 'turbo/generators/templates/**'] },
  ...node({ tsconfigRootDir: import.meta.dirname }),
  {
    rules: {
      // Scripts de engenharia: imprimem diagnóstico no terminal (nunca variáveis de ambiente
      // completas) e repassam o ambiente aos processos filhos (pnpm, docker, turbo).
      'contrataflow/no-console': 'off',
      'contrataflow/no-process-env': 'off',
      // Pacote privado de ferramentas: todas as dependências são de desenvolvimento.
      'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },
];
