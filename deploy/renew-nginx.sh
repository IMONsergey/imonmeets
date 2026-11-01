#!/usr/bin/env sh
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/*)
    /usr/sbin/nginx -t
    systemctl reload nginx
    # An installed project-specific hook refreshes the TURN certificate too.
    if [ -x /usr/local/lib/imonmeets/renew-turn ]; then
      /usr/local/lib/imonmeets/renew-turn "$RENEWED_LINEAGE"
    fi
    ;;
esac
