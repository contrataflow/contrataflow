# Identidade visual do ContrataFlow

Fonte da verdade da marca (DEC-185). Os PNGs desta pasta são os originais; na interface a marca é
renderizada por `BrandMark`/`BrandLogo` (`packages/ui/src/components/brand-logo.tsx`) — ícone
vetorial e palavra-marca em texto real.

## Ativos

| Arquivo | Uso | Dimensões |
|---|---|---|
| `contrataflow-logo-horizontal.png` | Logo horizontal: ícone + "ContrataFlow" + slogan "DO PLANEJAMENTO À CONTRATAÇÃO" | 1672×941, fundo transparente, arte em (41,202)–(1640,821) |
| `contrataflow-icone.png` | Ícone isolado (favicon, app, avatar da marca) | 1254×1254, fundo transparente, arte em (214,203)–(1069,1109) |

Derivados no código (regenerar a partir daqui quando a marca mudar):

- `apps/web/src/app/icon.svg` — favicon vetorial (a faixa navy clareia em aba escura);
- `apps/web/src/app/apple-icon.png` — 180×180, ícone sobre branco com margem (Pillow, a partir de
  `contrataflow-icone.png`);
- `apps/web/public/auth-theme/contrataflow-logo.svg` e `login-background.svg` — tema do Authentik (recuperação de senha e step-up; o login é nativo desde a DEC-187). O fundo é claro e só decorativo, **sem texto**: o cartão do IdP pode cobrir qualquer parte dele.

## Paleta

| Cor | Hex | Uso |
|---|---|---|
| Navy | `#141E2B` | "Contrata", faixa superior do ícone, títulos, toasts, cabeçalho de e-mail |
| Azul | `#005BF9` | "Flow", faixas inferiores do ícone, cor primária padrão |
| Azul profundo | `#004BE3` | hover/pressed, botões e links de e-mail |
| Azul claro (sobre navy) | `#6B9EFF` | "Flow" e foco sobre fundo navy; primária do tema escuro |

Os PNGs medem navy `#04121E` e azul `#004BE3` no logo horizontal; os valores canônicos acima são os
do ícone.

## Sistema de design v2 — tema claro (DEC-186)

A partir da repaginação de 2026-10 (prd-4) o **tema claro é o padrão** (`theme: 'light'` para quem
não escolheu outro; o escuro segue como opção em "Meu perfil", com os mesmos tokens semânticos). O
navy sai do fundo das telas e vai para títulos, logo e toasts; o azul é a ação. Prévia aprovada e
referência visual dos cards seguintes: [`mockups/repaginacao-2026-10/`](mockups/repaginacao-2026-10/README.md).

### Paleta de uso (tema claro)

| Papel | Token | Hex | Uso |
|---|---|---|---|
| Fundo da página | `background` | `#F4F6FA` | ground das telas |
| Superfície | `surface` | `#FFFFFF` | cartões, tabelas, menus |
| Borda | `border` / `border-strong` | `#E2E8F0` / `#CBD5E1` | divisores e cartões / campos e botões secundários |
| Texto | `foreground` | `#0F172A` | corpo |
| Texto secundário | `muted-foreground` | `#5B6B80` | apoio, rótulos (o `#64748B` da prévia fica 4,4:1 sobre o fundo; escurecido para AA) |
| Títulos | `brand-ink` | `#141E2B` | títulos de página e seção, números de KPI |
| Primária | `primary` / `primary-hover` | `#005BF9` / `#004BE3` | ação primária, item ativo, links no hover |
| Destaque | `primary-soft` / `-foreground` | `#E8F0FF` / `#004BE3` | item ativo, chip "em andamento", filtros |
| Sucesso | `success` · `-soft` · `-soft-foreground` | `#15803D` · `#DCFCE7` · `#166534` | concluído |
| Atenção | `warning` · `-soft` · `-soft-foreground` | `#B45309` · `#FEF3C7` · `#92400E` | prazo próximo, devolvido |
| Erro | `destructive` · `-soft` · `-soft-foreground` | `#B91C1C` · `#FEE2E2` · `#991B1B` | atrasado, suspenso, ação perigosa |
| Aprovação | `approval` · `-soft` · `-soft-foreground` | `#7C3AED` · `#EDE9FE` · `#5B21B6` | aguardando aprovação |
| Neutro | `neutral` · `-soft` · `-soft-foreground` | `#94A3B8` · `#F1F5F9` · `#334155` | rascunho, desabilitado (`neutral` só como marca gráfica, nunca texto) |
| Invertida | `inverse` · `-foreground` · `-muted` | `#141E2B` · `#FFFFFF` · `#B3BDCB` | toasts |

Tipografia Inter: `text-page-title` 28/800, `text-section-title` 16/700, corpo `text-sm` 14/400,
`text-label` 12/600 caixa alta, `text-kpi` 34/800. Grade de 8 px, raio `rounded-control` 10 px e
`rounded-card` 14 px, sombra `shadow-card` quase nula, foco visível de 3 px, alvos de 44 px
(`Button` `md` e `icon`).

### Componentes (`packages/ui`)

`Card`, `KpiTile`, `StatusChip`, `PageHeader`, `EmptyState`, `FilterChip`, `ViewTabs`, primitivos de
tabela (`TableContainer`, `Table`, `TableHead`, `TableBody`, `Tr`, `Th` ordenável, `Td`,
`TableFooter`), `Avatar`, `Kbd` e gráficos em SVG/CSS próprios (`BarList`, `Donut`, `ColumnChart`),
além dos existentes. Tons semânticos: `info`, `success`, `warning`, `danger`, `approval`, `neutral`
(gráficos aceitam também `navy`). Gráficos sempre trazem o texto (rótulo e valor visíveis, ou
`role="img"` com descrição completa): a cor nunca é a única informação. Cada componente tem
história no Storybook (`pnpm --filter @contrataflow/ui storybook`, com seletor de tema) e passa no
axe do CI.

## Tokens (`packages/ui/src/styles.css`)

- Fixos: `--color-brand-navy`, `--color-brand-blue`, `--color-brand-blue-deep`, `--color-sidebar-accent`
  e `--color-on-navy` / `-muted` / `-accent` (marca sobre navy: login e logo `onDark`).
- Por tema: `--color-brand-ink` / `--color-brand-accent` (cores da palavra-marca sobre o fundo do
  tema) e `--color-sidebar` / `-foreground` / `-muted` (menu lateral, ainda navy até o card do shell
  da repaginação).
- Semânticos (`background`, `foreground`, `surface`, `muted`, `border`, `ring`, `primary`…) derivam
  da paleta; todo par texto/fundo tem contraste ≥ 4,5:1 nos dois temas, e os ícones dos toasts ≥ 3:1
  (`packages/ui/src/lib/tokens-contrast.test.ts`). Os nomes do v1 seguem definidos (aliases) até a
  segunda leva da repaginação.
- O tema do tenant (`branding.primaryColor`, padrão `#005BF9`) troca só a primária (e o hover dela,
  que fica na mesma cor) — nunca a marca.

## Regras de uso

- **Área de respiro:** ao redor do logo, no mínimo a altura do "C" de "Contrata" livre de texto,
  bordas e outros elementos.
- **Tamanho mínimo:** ícone com 16 px (favicon) e lockup com ícone de 32 px; o slogan só aparece com
  o ícone a partir de 36 px (abaixo disso fica ilegível).
- **Sobre fundo escuro:** use o tom `onDark` — "Contrata" e a faixa superior em branco, "Flow" em
  `#6B9EFF`, slogan em `#B3BDCB`. As faixas azuis do ícone permanecem `#005BF9`.
- **Leitura:** o nome é uma palavra só, "ContrataFlow" (o componente expõe um texto único ao leitor
  de tela).

### Não fazer

- Não usar o PNG da palavra-marca como imagem em telas: o texto é real (nitidez e acessibilidade).
- Não recolorir, inclinar, esticar, contornar ou aplicar sombra no ícone ou na palavra-marca.
- Não trocar a fonte (Inter 800, tracking ≈ −0,03em; slogan Inter 400 em caixa alta, ≈ 0,25em).
- Não usar a cor primária do tenant na marca nem a marca de uma instituição no lugar dela (DEC-141).
- Não colocar o azul `#005BF9` como texto sobre navy (contraste insuficiente): use `#6B9EFF`.
