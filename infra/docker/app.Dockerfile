# Imagem de DESENVOLVIMENTO das aplicações para o perfil `full` do Compose (US-078 · FA-01):
# instala pelo lockfile e constrói api, web e worker. O uso padrão continua sendo `pnpm dev` no
# host (hot-reload); a imagem de produção é responsabilidade do pipeline (US-079).
# Contexto do build: raiz do repositório (veja .dockerignore — o `.env` nunca entra na imagem).
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1 \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1

RUN corepack enable && mkdir /repo && chown node:node /repo

USER node
WORKDIR /repo
COPY --chown=node:node . .

RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@contrataflow/api --filter=@contrataflow/web --filter=@contrataflow/worker

ENV NODE_ENV=production
