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
- `apps/web/public/auth-theme/contrataflow-logo.svg` e `login-background.svg` — tema do Authentik.

## Paleta

| Cor | Hex | Uso |
|---|---|---|
| Navy | `#141E2B` | "Contrata", faixa superior do ícone, menu lateral, cabeçalho de e-mail |
| Azul | `#005BF9` | "Flow", faixas inferiores do ícone, cor primária padrão |
| Azul profundo | `#004BE3` | hover/pressed, botões e links de e-mail |
| Azul claro (sobre navy) | `#6B9EFF` | "Flow" e foco sobre fundo navy; primária do tema escuro |

Os PNGs medem navy `#04121E` e azul `#004BE3` no logo horizontal; os valores canônicos acima são os
do ícone.

## Tokens (`packages/ui/src/styles.css`)

- Fixos: `--color-brand-navy`, `--color-brand-blue`, `--color-brand-blue-deep`, `--color-sidebar-accent`.
- Por tema: `--color-brand-ink` / `--color-brand-accent` (cores da palavra-marca sobre o fundo do
  tema) e `--color-sidebar` / `-foreground` / `-muted` (menu lateral).
- Semânticos (`background`, `foreground`, `surface`, `muted`, `border`, `ring`, `primary`…) derivam
  da paleta; todo par texto/fundo tem contraste ≥ 4,5:1 nos dois temas
  (`packages/ui/src/lib/tokens-contrast.test.ts`).
- O tema do tenant (`branding.primaryColor`, padrão `#005BF9`) troca só a primária — nunca a marca.

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
