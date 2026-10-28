# Prévia da repaginação — 2026-10 (prd-4)

Telas aprovadas pelo usuário em 2026-10-28 como referência visual da primeira leva da repaginação
do frontend (DEC-186). São as fontes do canvas de prévia (`.dc.html`, HTML com estilos em linha e
dados de exemplo no script `text/x-dc`); abrem direto no navegador para leitura do layout, sem o
`support.js` do canvas.

| Arquivo | Tela | Card que a implementa |
|---|---|---|
| `Sistema.dc.html` | Paleta com uso, tipografia, botões, campo, chips, KPI, toast e estado vazio | Sistema de design v2 (`packages/ui`) |
| `Main.dc.html` | Login nativo com usuário e senha e etapa de código | Login nativo |
| `Painel.dc.html` | Shell (barra lateral clara, barra superior) e painel com KPIs e gráficos | Shell e navegação; Painel |
| `Processos.dc.html` | Lista de processos com visões salvas, chips de filtro e tabela | Lista de processos |

Os valores de cor das telas são os da paleta de `docs/brand/README.md`, com uma exceção: o texto
secundário `#64748B` virou `#5B6B80` no token `muted-foreground`, para passar em 4,5:1 também sobre
o fundo `#F4F6FA`. Dados mostrados que a API não devolve (ex.: variação "desde ontem") ficam fora
das telas implementadas até existir contrato para eles.
