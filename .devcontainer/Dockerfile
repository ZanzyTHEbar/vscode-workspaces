# Node 20 matches the version used in .github/workflows/release.yml
FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

# Tools the Makefile needs besides node/pnpm:
#   glib-compile-schemas (libglib2.0-bin) and zip for `make pack`
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-bin zip make \
    && rm -rf /var/lib/apt/lists/*

# pnpm-lock.yaml is lockfileVersion 9.0, which needs pnpm 9
RUN npm install -g pnpm@9

USER node
# Keep the pnpm store inside the container instead of letting pnpm create
# a .pnpm-store directory in the bind-mounted workspace
RUN pnpm config set store-dir /home/node/.local/share/pnpm/store --global
