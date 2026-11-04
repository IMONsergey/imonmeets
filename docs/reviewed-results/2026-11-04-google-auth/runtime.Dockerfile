FROM imonmeets-app:9bb2dab-preview AS verified_dependencies
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY --from=verified_dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
COPY --chown=node:node apps/web/package.json ./apps/web/package.json
COPY --chown=node:node apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/web/dist ./apps/web/dist
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node artifact-manifest.json ./release-artifacts.json
LABEL org.opencontainers.image.revision="a3d816ff28cb4692d07c950d92642207a57f9a58"
LABEL org.opencontainers.image.source="https://github.com/IMONsergey/imonmeets"
LABEL com.imonmeets.dependencies-image="sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e"
USER node
EXPOSE 3540
CMD ["node", "apps/api/dist/server.js"]
