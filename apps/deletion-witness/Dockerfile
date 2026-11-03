FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG VCS_REF=unversioned
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
COPY --chown=node:node apps/deletion-witness/server.mjs /app/server.mjs
USER node
ENTRYPOINT ["/bin/sh", "-c", "umask 077; exec /usr/bin/flock -n /data/writer.lock node /app/server.mjs \"$@\"", "imonmeets-deletion-witness"]
