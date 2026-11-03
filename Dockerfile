FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts
COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ARG VCS_REF=unversioned
LABEL org.opencontainers.image.revision=$VCS_REF
ENV RELEASE_COMMIT=$VCS_REF
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 3540
CMD ["node", "apps/api/dist/server.js"]
