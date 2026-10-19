# Vercel builds Daemons for Linux amd64. Keep this file at the repository root:
# Vercel uses the Dockerfile's directory as its build context.
FROM node:22-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm AS worker

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
       ca-certificates git libstdc++6 tesseract-ocr tesseract-ocr-eng tini \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install --global --omit=dev @tencent-ai/codebuddy-code@2.164.0 \
    && npm cache clean --force \
    && groupadd --gid 10001 tutupbuku \
    && useradd --uid 10001 --gid tutupbuku --create-home --shell /usr/sbin/nologin tutupbuku

WORKDIR /app
ENV HOME=/home/tutupbuku

# Selective copies and the allow-list in .dockerignore keep local credentials,
# user uploads, exports, and previous working state out of the build context.
COPY pyproject.toml ./
COPY tutupbuku/ ./tutupbuku/
RUN python -m pip install --no-cache-dir .
COPY skills/ ./skills/
COPY .codebuddy/skills/tutupbuku/SKILL.md ./.codebuddy/skills/tutupbuku/SKILL.md
COPY demo-fixtures/ ./demo-fixtures/
COPY prisma/daemon.sql ./prisma/daemon.sql

# The worker uses a temporary runtime directory and checkpoints durable data in
# Postgres. /app holds the immutable application and synthetic baseline only.
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "tutupbuku.daemon"]
