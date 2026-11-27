FROM node:22-bookworm-slim AS frontend
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY editor/package.json editor/pnpm-lock.yaml editor/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY editor/index.html editor/tsconfig.json editor/vite.config.ts editor/print-runtime.json ./
COPY editor/src/ ./src/
COPY editor/public/ ./public/
RUN pnpm build

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY editor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY editor/server.py editor/project_store.py editor/lan_access.py editor/account_auth.py editor/community_store.py editor/asset_packages.py editor/card_asset_store.py ./
COPY --from=frontend /app/dist/ ./dist/
EXPOSE 10000
CMD ["sh", "-c", "exec python server.py --host 0.0.0.0 --port \"${PORT:-10000}\" --public-origin \"${RENDER_EXTERNAL_URL:?Set the public HTTPS address}\" --data-dir /var/data"]
