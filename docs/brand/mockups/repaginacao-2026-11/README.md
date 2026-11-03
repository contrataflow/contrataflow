# Prévia da repaginação — 2026-11 (prd-6, terceira leva)

Direção visual da terceira leva: a estrutura das telas do **Microlegis** (produto irmão, da Visual
Sistemas Eletrônicos) com a marca e a paleta do ContrataFlow. Prévia aprovada pelo usuário em
2026-11-03, com a fonte **Inter** (o alternador para a IBM Plex Sans da prévia é só comparação).

`previa-leva-3.html` abre direto no navegador (HTML com estilos em linha e dados de exemplo; quadros
de 1280 px, tema claro). As capturas em `referencia-microlegis/` são as telas do Microlegis que o
usuário enviou como referência.

| Tela da prévia | Referência do Microlegis | Card que a implementa |
|---|---|---|
| Kit: fonte, raio, cartão com borda, `FilterPanel`, `StatTile`, cabeçalho invertido, linha de contagem | todas | Leva 3 · 1/6 — base visual (`packages/ui`) |
| 1 · Login | `01-login.png` | Leva 3 · 2/6 — shell e login |
| 2 · Painel (shell + cartão-destaque) | `02-inicio.png` | Leva 3 · 2/6 (shell) e 3/6 (painel) |
| 3 · Lista de processos | `03-protocolo.png`, `04-materias.png`, `05-agenda-das-sessoes.png` | Leva 3 · 4/6 — listas |
| 4 · Administração (hub) | `06-administracao.png` | Leva 3 · 5/6 — administração |
| — (sem tela na prévia: Calendário no padrão do Microlegis) | `07-calendario-da-casa.png` | Leva 3 · 5/6 — administração |

Mapeamento de cores: vinho do Microlegis → azul `primary` (ação, item ativo, links); vinho escuro →
navy (`brand-navy`/`inverse`: cabeçalhos escuros, painel do login); rosa-claro → `primary-soft`.
Dados mostrados que a API não devolve ficam fora das telas implementadas até existir contrato para
eles. O que mudou no kit está em `docs/brand/README.md`, seção "Terceira leva".
