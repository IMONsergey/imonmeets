// Shared HTTP-only rendering. Inputs come from the strict edge topology builder.
import { ACME_MAIN_PORT } from "./edge-certificate-policy.mjs";

export const quiet = "    access_log off;\n    error_log /dev/null crit;\n    server_tokens off;";
const token = "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]{22,128}$";
export function challenge(body) {
  return `    location ~ "${token}" {
        if ($request_uri !~ "${token}") { return 404; }
        if ($request_method !~ "^(GET|HEAD)$") { return 405; }
${body}
    }
    location /.well-known/ { return 404; }`;
}
export function localChallenge(root, restrictions = "") {
  return challenge(`${restrictions}        root ${root};
        disable_symlinks on;
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        try_files $uri =404;`);
}
export function renderEdgeHttp({ edge, mainHosts, witnessHost, witnessWebroot }) {
  return `# Candidate HTTP bootstrap. No certificate is required for this file.
server {
    listen ${edge.publicListener.address}:80 default_server;
    server_name _;
${quiet}
    return 404;
}
${mainHosts.map((host) => `server {
    listen ${edge.publicListener.address}:80;
    server_name ${host};
${quiet}
${challenge(`        proxy_bind ${edge.tunnel.localIp};
        proxy_pass http://${edge.tunnel.mainIp}:${ACME_MAIN_PORT};
        proxy_pass_request_headers off;
        proxy_pass_request_body off;
        proxy_set_header Host ${host};
        proxy_set_header Content-Length "";
        proxy_connect_timeout 2s;
        proxy_read_timeout 5s;
        proxy_send_timeout 5s;
        proxy_buffering off;`)}
    location / { return 308 https://${host}$request_uri; }
}`).join("\n")}
server {
    listen ${edge.publicListener.address}:80;
    server_name ${witnessHost};
${quiet}
${localChallenge(witnessWebroot)}
    location / { return 308 https://${witnessHost}$request_uri; }
}
`;
}
export function renderLoopbackMainAcme({ mainHosts, mainWebroot }) {
  return `# Candidate loopback handler. The source-ACL TCP bridge owns the WG bind.
server {
    listen 127.0.0.1:${ACME_MAIN_PORT} default_server;
    server_name _;
${quiet}
    return 404;
}
server {
    listen 127.0.0.1:${ACME_MAIN_PORT};
    server_name ${mainHosts.join(" ")};
${quiet}
    set_real_ip_from 127.0.0.1;
    real_ip_header proxy_protocol;
    allow 127.0.0.1/32;
    deny all;
${localChallenge(mainWebroot)}
    location / { return 404; }
}
`;
}
