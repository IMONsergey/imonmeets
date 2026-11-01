#!/usr/bin/env python3
"""Install the scoped local exporter; print the nginx include path for review."""
import argparse
import os
import pathlib
import re
import secrets
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--project", type=pathlib.Path,
                    default=pathlib.Path(__file__).resolve().parent.parent)
args = parser.parse_args()
project = args.project.resolve()
if os.geteuid() != 0:
    raise SystemExit("Run with sudo")
if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(project)):
    raise SystemExit("Unsupported project path")
for name in ["backups", "ops-state"]:
    source = project / name
    if not source.is_dir() or source.is_symlink():
        raise SystemExit(f"Create a real project {name} directory before installing the exporter")
private = pathlib.Path("/etc/imonmeets")
private.mkdir(mode=0o700, exist_ok=True)
private.chmod(0o700)
token = private / "offsite-token"
if token.is_symlink():
    raise SystemExit("Export token must not be a symlink")
if not token.exists():
    fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as target:
        target.write(secrets.token_urlsafe(48) + "\n")
token.chmod(0o600)
os.chown(token, 0, 0)
installed_dir = pathlib.Path("/usr/local/lib/imonmeets")
installed_dir.mkdir(parents=True, exist_ok=True)
installed_dir.chmod(0o755)
installed_server = installed_dir / "offsite-export-server.py"
if installed_server.is_symlink():
    raise SystemExit("Installed exporter must not be a symlink")
shutil.copyfile(pathlib.Path(__file__).with_name("offsite-export-server.py"), installed_server)
os.chown(installed_server, 0, 0)
installed_server.chmod(0o755)
pathlib.Path("/etc/systemd/system/imonmeets-offsite-export.service").write_text(f"""[Unit]
Description=IMON Meets encrypted offsite export
After=network.target
[Service]
Type=simple
RuntimeDirectory=imonmeets-export
RuntimeDirectoryMode=0700
BindReadOnlyPaths={project}/backups:/run/imonmeets-export/backups
BindReadOnlyPaths={project}/ops-state:/run/imonmeets-export/ops-state
ExecStart=/usr/bin/python3 {installed_server} --project /run/imonmeets-export --token-file {token}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
CapabilityBoundingSet=
MemoryMax=64M
CPUQuota=10%
TasksMax=8
[Install]
WantedBy=multi-user.target
""")
nginx = pathlib.Path("/etc/nginx/snippets/imonmeets-offsite.conf")
nginx.parent.mkdir(exist_ok=True)
nginx.write_text("""# Include only in the IMON Meets API TLS server block.
location = /_ops/backup {
    limit_req zone=imonmeets_ops burst=10 nodelay;
    access_log off;
    proxy_pass http://127.0.0.1:3542;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 90s;
    proxy_send_timeout 30s;
    proxy_buffering off;
    client_max_body_size 1k;
}
location = /_ops/health {
    limit_req zone=imonmeets_ops burst=10 nodelay;
    access_log off;
    proxy_pass http://127.0.0.1:3542;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 10s;
    client_max_body_size 1k;
}
""")
pathlib.Path("/etc/nginx/conf.d/imonmeets-ops-rate.conf").write_text(
    "limit_req_zone $binary_remote_addr zone=imonmeets_ops:1m rate=30r/m;\n")
subprocess.run(["systemctl", "daemon-reload"], check=True)
subprocess.run(["systemctl", "enable", "imonmeets-offsite-export.service"], check=True)
subprocess.run(["systemctl", "restart", "imonmeets-offsite-export.service"], check=True)
print("Exporter installed on loopback 3542. Add include /etc/nginx/snippets/imonmeets-offsite.conf; to the existing API TLS server, then nginx -t and reload.")
