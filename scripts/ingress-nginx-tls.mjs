// Shared protected TLS server blocks for single-host and edge/main candidates.
// Only callers with already-validated configuration may use these pure renderers.
export function nginxTlsLayout(c, layout = {}) {
  return {
    nginxPort: 8445,
    apiPort: 3540,
    rtcPort: 7880,
    s3Port: 8333,
    cert: `/etc/letsencrypt/live/${c.certificate}/fullchain.pem`,
    key: `/etc/letsencrypt/live/${c.certificate}/privkey.pem`,
    trust: "/etc/nginx/snippets/imonmeets-commercial-trust.conf",
    signal: "/etc/nginx/snippets/imonmeets-signaling-auth.conf",
    ...layout,
  };
}

// The optional HTTP prefix is generated only by the legacy single-host caller.
// Empty by default: the edge/main candidate exposes only loopback TLS here.
export function renderNginxTlsContext(c, p = nginxTlsLayout(c), httpServers = "") {
  const certificate = `    ssl_certificate ${p.cert};
    ssl_certificate_key ${p.key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;`;
  const listener = `    listen 127.0.0.1:${p.nginxPort} ssl proxy_protocol;
    set_real_ip_from 127.0.0.1;
    real_ip_header proxy_protocol;
    access_log off;
    error_log /dev/null crit;
    server_tokens off;`;
  // Error logs can include a request URI with a LiveKit JWT or signed S3 URL.
  // Suppress request logs here; availability metrics belong at the API/monitor.
  const apiHeaders = `        proxy_set_header Host ${c.app};
        proxy_set_header X-Forwarded-Host ${c.app};
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Forwarded "";
        proxy_set_header X-IMON-Client-IP "";
        include ${p.trust};`;
  const signalLocations = [
    "/rtc",
    "/rtc/validate",
    "/rtc/v1",
    "/rtc/v1/validate",
  ]
    .map(
      (uri) => `    location = ${uri} {
        limit_except GET { deny all; }
        set $imon_livekit_query_token $arg_access_token;
        auth_request /_imon_livekit_admission;
        error_page 500 502 504 =503 @imon_signal_unavailable;
        proxy_pass http://127.0.0.1:${p.rtcPort};
        proxy_http_version 1.1;
        proxy_set_header Host ${c.rtc};
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $imon_443_upgrade;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-IMON-Proxy-Secret "";
        proxy_set_header X-IMON-LiveKit-Auth "";
        proxy_set_header X-IMON-LiveKit-Token "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }`,
    )
    .join("\n");
  const storage = c.storage
    ? `
server {
${listener}
    server_name ${c.storage};
${certificate}
    location = /imon-recordings { return 404; }
    location = /imon-recordings/ { return 404; }
    location ^~ /imon-recordings/ {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:${p.s3Port};
        proxy_http_version 1.1;
        # SigV4 binds the original Host, path and query. Do not rewrite them.
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-IMON-Proxy-Secret "";
        proxy_set_header X-IMON-LiveKit-Auth "";
        proxy_set_header X-IMON-LiveKit-Token "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 120s;
        proxy_buffering off;
        add_header Cache-Control "private, no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
    location / { return 404; }
}
`
    : "";
  return `# Candidate only. Included in nginx http {}, never installed by this script.
map $http_upgrade $imon_443_upgrade {
    default upgrade;
    '' close;
}
${httpServers}server {
    listen 127.0.0.1:${p.nginxPort} ssl proxy_protocol default_server;
    server_name _;
    ssl_reject_handshake on;
    access_log off;
    error_log /dev/null crit;
    return 444;
}
server {
${listener}
    server_name ${c.app};
${certificate}
    client_max_body_size 128k;
    location ^~ /api/internal/ { return 404; }
    location / {
        proxy_pass http://127.0.0.1:${p.apiPort};
        proxy_http_version 1.1;
${apiHeaders}
        proxy_set_header X-IMON-LiveKit-Auth "";
        proxy_set_header X-IMON-LiveKit-Token "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 90s;
        proxy_buffering off;
    }
}
server {
${listener}
    server_name ${c.rtc};
${certificate}
    client_max_body_size 8k;
    location = /_imon_livekit_admission {
        internal;
        proxy_pass http://127.0.0.1:${p.apiPort}/api/internal/livekit/authorize;
        proxy_method GET;
        proxy_pass_request_body off;
        proxy_pass_request_headers off;
        proxy_set_header Content-Length "";
${apiHeaders}
        include ${p.signal};
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-IMON-LiveKit-Token $imon_livekit_query_token;
        proxy_connect_timeout 2s;
        proxy_read_timeout 5s;
    }
${signalLocations}
    location @imon_signal_unavailable { return 503; }
    location / { return 404; }
}
${storage}`;
}
