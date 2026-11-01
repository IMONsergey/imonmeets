#!/usr/bin/env python3
"""Install only IMON Meets backup and local health timers. Run with sudo."""
import os,pathlib,re,shutil,subprocess
project=pathlib.Path(__file__).resolve().parent.parent
if os.geteuid()!=0: raise SystemExit("Run this installer with sudo")
if not re.fullmatch(r"/[A-Za-z0-9_./-]+",str(project)): raise SystemExit("Unsupported project path")
node=shutil.which("node")
if not node: raise SystemExit("Node is required")
def unit(name,body):
 p=pathlib.Path("/etc/systemd/system")/name;p.write_text(body);p.chmod(0o644)
common=f"""[Unit]
Description=IMON Meets
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
WorkingDirectory={project}
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=300
"""
unit("imonmeets-backup.service",common+f"ExecStart=/usr/bin/bash {project}/scripts/backup.sh\n")
unit("imonmeets-backup.timer","""[Unit]
Description=Hourly IMON Meets backup
[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true
[Install]
WantedBy=timers.target
""")
unit("imonmeets-health.service",common+f"ExecStart={node} {project}/scripts/check-operations.mjs\n")
unit("imonmeets-health.timer","""[Unit]
Description=IMON Meets local operational checks
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
""")
unit("imonmeets-restore-check.service",common.replace("TimeoutStartSec=300", "TimeoutStartSec=1800")+f"ExecStart=/usr/bin/bash {project}/scripts/check-latest-restore.sh\n")
unit("imonmeets-restore-check.timer","""[Unit]
Description=Weekly IMON Meets disposable restore check
[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
""")
hooks=pathlib.Path("/usr/local/lib/imonmeets");hooks.mkdir(parents=True,exist_ok=True);hooks.chmod(0o755)
renew=hooks/"renew-turn"
renew.write_text(f"""#!/usr/bin/env bash
set -euo pipefail
cd {project}
test -f deploy/turn-private/turnserver.conf || exit 0
expected_lineage="$({node} --env-file=.env -e 'process.stdout.write("/etc/letsencrypt/live/" + (process.env.TLS_CERT_NAME || "imonmeets-preview"))')"
test "$1" = "$expected_lineage" || exit 0
{node} --env-file=.env scripts/prepare-turn.mjs --cert-only --lineage "$1"
docker compose restart turn
""");renew.chmod(0o755)
certbot=pathlib.Path("/etc/letsencrypt/renewal-hooks/deploy/imonmeets-nginx")
certbot.parent.mkdir(parents=True,exist_ok=True)
shutil.copyfile(project/"deploy/renew-nginx.sh",certbot);certbot.chmod(0o755)
subprocess.run(["systemctl","daemon-reload"],check=True)
for name in ["imonmeets-backup.timer","imonmeets-health.timer","imonmeets-restore-check.timer"]:
 subprocess.run(["systemctl","enable","--now",name],check=True)
print("Installed project backup, health and restore timers; certificate hook refreshed.")

