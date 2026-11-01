#!/usr/bin/env sh
set -eu
case "${RENEWED_LINEAGE:-}" in
  */imonmeets-preview)
    /usr/sbin/nginx -t
    systemctl reload nginx
    ;;
esac
