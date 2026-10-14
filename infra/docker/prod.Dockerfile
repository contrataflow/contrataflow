# Imagens de PRODUÇÃO de api, web e worker (US-079 — estágio "Imagens", RN-FND-26). Uma imagem por
# app, promovida sem rebuild de staging para produção (architecture.md §11.4):
#   docker build -f infra/docker/prod.Dockerfile --build-arg APP=api --target runtime-api .
# Multi-stage: workspace podado pelo Turborepo → instalação pelo lockfile → build → dependências de
# produção instaladas do zero → runtime mínimo (`-slim`), usuário não-root, código somente leitura
# (security.md §17). Contexto: raiz do repositório (o .dockerignore deixa `.env` e `.git` fora).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1 \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# 1. Só o app e os pacotes de que ele depende (lockfile podado), separados em manifestos e fontes.
FROM base AS prune
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.7 prune "@contrataflow/${APP}" --docker --out-dir /pruned

# 2. Instalação (camada reaproveitada enquanto manifestos e lockfile não mudam) e build. Do build só
#    saem os artefatos (`dist/`, `.next/`, `public/`, `next.config.ts`), reunidos em /out.
FROM base AS build
ARG APP
COPY --from=prune /pruned/json/ .
RUN --mount=type=cache,id=cf-pnpm-store,target=/root/.cache/pnpm-store \
    pnpm config set store-dir /root/.cache/pnpm-store \
 && pnpm install --frozen-lockfile
COPY --from=prune /pruned/full/ .
RUN pnpm turbo run build --filter="@contrataflow/${APP}" \
 && for dir in apps/* packages/*; do \
      for item in dist .next public next.config.ts; do \
        if [ -e "$dir/$item" ]; then mkdir -p "/out/$dir" && cp -a "$dir/$item" "/out/$dir/"; fi; \
      done; \
    done \
 && rm -rf /out/apps/web/.next/cache

# 3. Dependências de produção do app e dos pacotes do workspace que ele usa, do zero e pelo mesmo
#    lockfile. eslint-config e tsconfig ficam de fora: são devDependencies, mas o filtro `app...`
#    os selecionaria e instalaria as ferramentas que eles declaram como dependências.
FROM base AS deps
ARG APP
COPY --from=prune /pruned/json/ .
RUN --mount=type=cache,id=cf-pnpm-store,target=/root/.cache/pnpm-store \
    pnpm config set store-dir /root/.cache/pnpm-store \
 && pnpm install --frozen-lockfile --prod --prefer-offline --ignore-scripts \
      --filter "@contrataflow/${APP}..." \
      --filter "!@contrataflow/eslint-config" \
      --filter "!@contrataflow/tsconfig"

# 4. Runtime comum: sem gerenciadores de pacote nem compiladores; arquivos do root, somente leitura
#    para o usuário `node`. Correções de segurança do Debian publicadas depois do digest da base
#    entram no build, e npm/npx/corepack/yarn saem (o runtime não os usa e as CVEs das dependências
#    empacotadas neles somem junto — RN-FND-26).
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /repo /app
COPY --from=build /out /app
USER node

FROM runtime-base AS runtime-api
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime-base AS runtime-worker
WORKDIR /app/apps/worker
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime-base AS runtime-web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
