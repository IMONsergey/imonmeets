import { isIP } from "node:net";
import { chmod, writeFile } from "node:fs/promises";

const ip = process.env.LIVEKIT_PUBLIC_IP;
const api = process.env.PUBLIC_API_HOST;
const rtc = process.env.PUBLIC_MEDIA_HOST;
const cert = process.env.TLS_CERT_NAME || "imonmeets-preview";
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
if (isIP(ip || "") !== 4)
  throw new Error("LIVEKIT_PUBLIC_IP must be an IPv4 address");
for (const host of [api, rtc]) {
  if (!hostPattern.test(host || ""))
    throw new Error("Set valid PUBLIC_API_HOST and PUBLIC_MEDIA_HOST");
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cert))
  throw new Error("Invalid TLS_CERT_NAME");

const recordingProxy =
  process.env.S3_BUCKET === "imon-recordings"
    ? `    location = /imon-recordings { return 404; }
    location = /imon-recordings/ { return 404; }
    location ^~ /imon-recordings/ {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:8333;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 8443;
        proxy_connect_timeout 5s;
        proxy_read_timeout 120s;
        proxy_buffering off;
        access_log off;
        add_header Cache-Control "private, no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
`
    : "";

const acme = `server {
    listen ${ip}:80;
    server_name ${api} ${rtc};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/imonmeets-acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 404; }
}
`;
const nginx = `# Generated public review ingress. Never add a listener on the occupied VPN port.
map $http_upgrade $imonmeets_connection_upgrade {
    default upgrade;
    '' close;
}
${acme}
server {
    listen ${ip}:8443 ssl;
    server_name ${api};
    ssl_certificate /etc/letsencrypt/live/${cert}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cert}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    client_max_body_size 128k;
${process.env.OFFSITE_EXPORT_ENABLED === "true" ? "    include /etc/nginx/snippets/imonmeets-offsite.conf;\n" : ""}
${recordingProxy}    location /embed/ {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:3540;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $http_x_forwarded_for;
        proxy_set_header X-Imon-Client-IP '';
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_buffering off;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3540;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $http_x_forwarded_for;
        proxy_set_header X-Imon-Client-IP '';
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_buffering off;
    }
    location / { return 404; }
}
server {
    listen ${ip}:8443 ssl;
    server_name ${rtc};
    ssl_certificate /etc/letsencrypt/live/${cert}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cert}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $imonmeets_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
`;
const media = `port: 7880
bind_addresses: [0.0.0.0]
rtc:
  node_ip: ${ip}
  use_external_ip: false
  advertise_internal_ip: true
  enable_loopback_candidate: false
  tcp_port: 7881
  udp_port: 7882
room:
  auto_create: false
  empty_timeout: 300
  departure_timeout: 30
  max_participants: 25
redis:
  address: redis:6379
logging:
  level: warn
`;
const files = [
  ["../deploy/nginx.acme.generated.conf", acme],
  ["../deploy/nginx.public.conf", nginx],
  ["../deploy/livekit.public.yaml", media],
];
for (const [name, contents] of files) {
  const destination = new URL(name, import.meta.url);
  await writeFile(destination, contents, { mode: 0o644 });
  // These generated files contain public routing/configuration, not secrets.
  // Explicit chmod is required when the operator uses a restrictive umask.
  await chmod(destination, 0o644);
}
console.log(
  "Generated ACME bootstrap, TLS ingress and public media configuration. No host configuration was changed.",
);
