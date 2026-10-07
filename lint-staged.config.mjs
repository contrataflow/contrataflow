// Conveniência local (o CI da US-079 repete tudo): ESLint --fix e Prettier nos arquivos staged.
// A flag faz o ESLint usar o eslint.config.mjs mais próximo de cada arquivo (por pacote).
const ESLINT = 'eslint --flag v10_config_lookup_from_file --fix --max-warnings=0 --no-warn-ignored';

export default {
  '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}': [ESLINT, 'prettier --write'],
  '*.{json,jsonc,json5,md,yaml,yml,css,html}': ['prettier --write --ignore-unknown'],
};
