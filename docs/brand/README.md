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
| Fundo da página | `background` | `#F7F8FA` | ground das telas (era `#F4F6FA` até a 2ª leva) |
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
`rounded-card` 14 px, sombra `shadow-card` (contorno de 1 px + elevação mínima: cartões sem borda
desde a 2ª leva), foco visível de 3 px, alvos de 44 px
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

### Kit de componentes da 2ª leva (prd-5 · DEC-188)

Padrão **shadcn/ui sobre Radix** (o pacote `radix-ui` já presente) e ícones **Lucide**, para as
telas deixarem de usar controles nativos (`<select>`, checkbox, `type="date"`, radio):

- **Formulário:** `Field` (rótulo + ajuda + erro; liga `id`, `aria-describedby`, `aria-invalid` e
  `aria-required` ao controle de dentro; `group` vira `fieldset`/`legend`), `Label`, `Input` (com
  `icon`), `Textarea` (cresce com o texto), `Select`, `Combobox` (busca + "nenhum resultado"),
  `Checkbox` (com estado misto), `RadioGroup`, `Switch`, `Calendar`, `DatePicker` e
  `DateRangePicker` (pt-BR, `dd/MM/aaaa`; `toIsoDate`/`fromIsoDate` para o `aaaa-MM-dd` da API).
- **Sobreposição:** `Popover`, `Tooltip` e `InfoTooltip` (ajuda em ícone — regra 7), `Sheet`
  (painel lateral, `size="wide"`; `SheetHeader`/`SheetBody`/`SheetFooter`, só o corpo rola),
  `CommandDialog` (paleta Ctrl K) e `Command*`.
- **Navegação e estrutura:** `Tabs` (Radix; `ViewTabs` usa por baixo), `Breadcrumb` (usado pelo
  `PageHeader`), `StageProgress` (etapas como pontos ligados, detalhe só na atual), `Separator`,
  `Progress`, `Collapsible` ("Ver mais") e `Accordion`.
- **Listas:** `FilterToolbar` — busca inline, botão "Filtros" com contador (popover fechado por
  padrão), ordenação e chips do que está ativo.
- **Ajustes:** `Button` com `iconLeft`/`iconRight` e variante `link`; `Card`, `TableContainer` e
  `Dialog` sem borda (sombra); `StatusChip` com `icon`; `EmptyState` com ícone Lucide (`Inbox` por
  padrão, `icon={null}` para nenhum).

Como usar: tudo sai de `@contrataflow/ui`, inclusive os ícones (`import { Plus } from
'@contrataflow/ui'`) — o app nunca importa `lucide-react` direto; ícone novo entra em
`packages/ui/src/icons.ts`. Textos padrão dos componentes estão em pt-BR (`*_LABELS`) e podem ser
trocados pela prop `labels` com as mensagens do app. Quem copiar um trecho do shadcn encontra as
variáveis que ele espera (`--background`, `--primary`, `--radius`… e as utilitárias `bg-popover`,
`bg-accent`, `border-input`) como apelidos dos tokens do design system. **Só a página rola**
(regra 8): abas, etapas, chips e barras quebram linha; rolagem interna só em `TableContainer`, corpo
de Dialog/Sheet, listas de Select/Command e blocos de código.

Peso (esbuild, minificado + gzip, sem React/Radix): os 23 ícones do shell ≈ 3,8 KB; `Select` +
`Input` + `Field` + `Checkbox` ≈ 3,2 KB; `Combobox` + `CommandDialog` (cmdk) ≈ 8 KB;
`DatePicker` + `DateRangePicker` (react-day-picker + date-fns pt-BR) ≈ 27 KB — nas telas, carregar
o seletor de data com `next/dynamic` quando ele não aparece de cara.

Capturas das histórias do kit (Storybook estático, 720 px): `screenshots/kit-2026-10/kit-claro.png`
e `kit-escuro.png`.

### Modelos de página (prd-5 · Leva 2 · 2/11)

Cada tela adota o modelo da sua família (`packages/ui/src/components/*-page.tsx`, com histórias e
axe). Os modelos só arrumam o layout: recebem os blocos prontos (cabeçalho, abas, barra de filtros,
tabela) e não buscam dados.

| Modelo | Quando usar | Estrutura |
|---|---|---|
| `ListPage` | Listas e caixas (processos, tarefas, aprovações, fornecedores, auditoria, cadastros) | `PageHeader` → `ViewTabs` → `FilterToolbar` → avisos → `TableContainer` com rodapé de contagem/paginação; props `loading` (esqueleto `ListPageSkeleton`), `error` e `empty` |
| `DetailPage` | Uma entidade com etapas e abas (processo, aprovação, documento) | Faixa de cabeçalho (trilha, título, chips, linha de identificação, "Mais" + ação primária) → cartão com `StageProgress` e fatos-chave em linha → avisos → abas → `DetailGrid` 2/3 + 1/3 (a coluna lateral desce abaixo de 1024 px) |
| `FormPage` / `WizardShell` | Criar ou editar (novo processo, DFD, ETP, TR, formulários de cadastro) | Coluna de 720 px com `FormSection` e `FormActionBar` fixa no rodapé (Salvar rascunho · Continuar, `AutosaveIndicator` à esquerda, `RecoveredDraftBanner` em `notices`); no assistente, passos à esquerda a partir de 1024 px e `StageProgress` abaixo disso |
| `SettingsPage` | Configurações em seções (órgão, perfil, notificações) | Seções à esquerda (linha que quebra em tela estreita), formulário da seção à direita, `aria-current` na atual |

Regras verificadas por teste em `apps/web/src/components/templates/`: **só a página rola**
(`no-nested-scroll.test.ts` — rolagem interna só em tabela larga, corpo de diálogo/gaveta, lista
suspensa ou bloco de código; as violações restantes estão na lista `PENDING`, com o card que as
remove) e **nenhum controle nativo** em `features` (`no-native-controls.test.ts` — a lista
`NOT_MIGRATED` diz qual card migra cada arquivo e chega a zero no card 11). As duas listas só
encolhem: o teste reprova entrada de arquivo que já foi corrigido.

O shell segue as mesmas regras: "Novo processo" só na barra superior (o cabeçalho das páginas não o
repete); Ctrl K abre a paleta de comandos (`CommandPalette`: busca de processos pela PRC-01, "Novo
processo" e "Ir para" as áreas do menu, com as permissões do menu); dicas (`Tooltip`) nos botões só
de ícone; o menu lateral não rola por dentro (fixo com 768 px de altura ou mais; abaixo disso rola
com a página).

### Capturas da primeira leva (2026-10)

Build de produção com a API simulada (`apps/web/test/e2e/support/mock-api.mjs`), em
`screenshots/repaginacao-2026-10/`. Servem de referência visual para a segunda leva; regenerar
quando uma tela mudar de aspecto. Painel, lista e página do processo foram regeneradas no card 2 da
segunda leva (modelos de página), junto com `paleta-de-comandos.png` (Ctrl K aberto, 1280 px).

| Tela | Claro (1280 px) | Escuro | Celular (390 px) |
|---|---|---|---|
| Login (`/entrar`) | `login.png` | — | `login-celular.png` |
| Painel | `painel.png` | `painel-escuro.png` | `painel-celular.png` |
| Lista de processos | `lista-de-processos.png` | `lista-de-processos-escuro.png` | `lista-de-processos-celular.png` |
| Página do processo | `pagina-do-processo.png` | `pagina-do-processo-escuro.png` | `pagina-do-processo-celular.png` |
| Caixa de tarefas (card 3) | `caixa-de-tarefas.png` | `caixa-de-tarefas-escuro.png` | `caixa-de-tarefas-celular.png` |
| Caixa de tarefas vazia | `caixa-de-tarefas-vazia.png` | `caixa-de-tarefas-vazia-escuro.png` | `caixa-de-tarefas-vazia-celular.png` |
| Aprovações (card 3) | `aprovacoes.png` | `aprovacoes-escuro.png` | `aprovacoes-celular.png` |
| Aprovações vazia | `aprovacoes-vazia.png` | `aprovacoes-vazia-escuro.png` | `aprovacoes-vazia-celular.png` |
| Decisão da aprovação | `decisao-da-aprovacao.png` | `decisao-da-aprovacao-escuro.png` | `decisao-da-aprovacao-celular.png` |
| Novo processo · passo 1 (card 4) | `novo-processo-passo-1.png` | `novo-processo-passo-1-escuro.png` | `novo-processo-passo-1-celular.png` |
| Novo processo · passo 2 | `novo-processo-passo-2.png` | `novo-processo-passo-2-escuro.png` | `novo-processo-passo-2-celular.png` |
| Menu "Mais" do processo | `processo-menu-mais.png` | `processo-menu-mais-escuro.png` | `processo-menu-mais-celular.png` |
| Diálogo Atribuir responsável | `dialogo-atribuir.png` | `dialogo-atribuir-escuro.png` | `dialogo-atribuir-celular.png` |
| Diálogo Suspender processo | `dialogo-suspender.png` | `dialogo-suspender-escuro.png` | `dialogo-suspender-celular.png` |
| Diálogo Cancelar processo | `dialogo-cancelar.png` | `dialogo-cancelar-escuro.png` | `dialogo-cancelar-celular.png` |
| Aba Tramitação | `aba-tramitacao.png` | `aba-tramitacao-escuro.png` | `aba-tramitacao-celular.png` |
| Aba Itens | `aba-itens.png` | `aba-itens-escuro.png` | `aba-itens-celular.png` |
| DFD · Identificação (card 5) | `dfd-identificacao.png` | `dfd-identificacao-escuro.png` | `dfd-identificacao-celular.png` |
| DFD · Planejamento | `dfd-planejamento.png` | `dfd-planejamento-escuro.png` | `dfd-planejamento-celular.png` |
| ETP · seção e "O que falta" | `etp-secao.png` | `etp-secao-escuro.png` | `etp-secao-celular.png` |
| ETP · quadro de alternativas | `etp-alternativas.png` | `etp-alternativas-escuro.png` | `etp-alternativas-celular.png` |
| TR · itens | `tr-itens.png` | `tr-itens-escuro.png` | `tr-itens-celular.png` |
| Fornecedores (card 7) | `fornecedores.png` | `fornecedores-escuro.png` | `fornecedores-celular.png` |
| Auditoria · Registros | `auditoria.png` | `auditoria-escuro.png` | `auditoria-celular.png` |
| Notificações | `notificacoes.png` | `notificacoes-escuro.png` | `notificacoes-celular.png` |
| Meu perfil | `perfil.png` | `perfil-escuro.png` | `perfil-celular.png` |
| Administração · hub (card 8) | `administracao.png` | `administracao-escuro.png` | `administracao-celular.png` |
| Usuários · lista | `usuarios.png` | `usuarios-escuro.png` | `usuarios-celular.png` |
| Usuários · detalhe | `usuario-detalhe.png` | `usuario-detalhe-escuro.png` | `usuario-detalhe-celular.png` |
| Perfis · matriz de permissões | `perfis-matriz.png` | `perfis-matriz-escuro.png` | `perfis-matriz-celular.png` |
| Configurações · Segurança | `configuracoes-seguranca.png` | `configuracoes-seguranca-escuro.png` | `configuracoes-seguranca-celular.png` |
| Configurações · Inteligência artificial | `configuracoes-ia.png` | `configuracoes-ia-escuro.png` | `configuracoes-ia-celular.png` |
| Estrutura · Órgãos | `estrutura.png` | `estrutura-escuro.png` | `estrutura-celular.png` |
| Calendário | `calendario.png` | `calendario-escuro.png` | `calendario-celular.png` |
| Templates · lista (card 9) | `templates.png` | `templates-escuro.png` | `templates-celular.png` |
| Templates · editor de versão | `editor-de-template.png` | `editor-de-template-escuro.png` | `editor-de-template-celular.png` |
| Workflows · editor | `editor-de-workflow.png` | `editor-de-workflow-escuro.png` | `editor-de-workflow-celular.png` |
| Workflows · regras | `regras-do-workflow.png` | `regras-do-workflow-escuro.png` | `regras-do-workflow-celular.png` |
| Catálogos | `catalogos.png` | `catalogos-escuro.png` | `catalogos-celular.png` |

Painéis do card 7 (1280 px, claro): `fornecedores-formulario.png` (painel lateral "Novo
fornecedor"), `auditoria-filtros.png` (painel "Filtros da auditoria") e `notificacoes-sino.png`
(popover do sininho com as 5 mais recentes).

Telas ainda no layout anterior (legíveis nos dois temas, a redesenhar na segunda leva): formulários e
editores (pesquisa de preços, riscos, documentos). Contraste e rolagem horizontal foram
varridos em todas as rotas do web nos dois temas e em 390 px (axe WCAG 2.1 AA sem violações).

## Tokens (`packages/ui/src/styles.css`)

- Fixos: `--color-brand-navy`, `--color-brand-blue`, `--color-brand-blue-deep` e `--color-on-navy` /
  `-muted` / `-accent` (marca sobre navy: login e logo `onDark`).
- Por tema: `--color-brand-ink` / `--color-brand-accent` (cores da palavra-marca sobre o fundo do
  tema) e `--color-sidebar` / `-foreground` / `-muted` / `-accent` (barra lateral: branca no claro,
  `#0B1118` no escuro; `-accent` é o foco visível). O item ativo do menu usa `primary-soft` com
  indicador de 3 px na `primary`.
- Apelidos do shadcn/ui (2ª leva): `--background`, `--foreground`, `--card`, `--popover`,
  `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`,
  `--ring` e `--radius` (+ `-foreground`) no `:root`, apontando para os `--color-*`; resolvem no
  tema do `:root` — o tema por tenant (num elemento interno) vale para os `--color-*`, que são o
  que os componentes do kit usam. `--shadow-popover` é a sombra de popovers, menus e diálogos.
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
