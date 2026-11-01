#!/usr/bin/env python3
"""Install the incremental recording worker; accept a snapshot before scheduling."""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import tempfile
import time


MARKER = "# Managed by IMON Meets recording backup installer"
RECIPIENT = pathlib.Path("/etc/imonmeets/backup-recipient.pem")
INSTALLED = pathlib.Path("/usr/local/lib/imonmeets/recording-backup.py")
SERVICE = "imonmeets-recording-backup.service"
TIMER = "imonmeets-recording-backup.timer"


def regular(path):
    if path.is_symlink() or not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
        raise SystemExit(f"A real regular file is required: {path}")


def atomic_write(path, data, mode):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise SystemExit(f"Refusing an unexpected target: {path}")
    fd, name = tempfile.mkstemp(prefix=".imonmeets-install-", dir=path.parent)
    temporary = pathlib.Path(name)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        temporary.chmod(mode)
        os.chown(temporary, 0, 0)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run this installer with sudo")
    os.umask(0o077)
    supplied = args.project.absolute()
    project = supplied.resolve(strict=True)
    if supplied != project or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(project)):
        raise SystemExit("Use the real absolute project path without symlink components")
    for directory in (project, project / "backups", RECIPIENT.parent):
        if directory.is_symlink() or not directory.is_dir() or directory.resolve() != directory:
            raise SystemExit(f"A real directory is required: {directory}")
    for path in (project / ".env", project / "compose.yml", RECIPIENT):
        regular(path)
    if RECIPIENT.stat().st_uid != 0:
        raise SystemExit("The existing backup recipient certificate must be root owned")
    source = pathlib.Path(__file__).with_name("recording-backup.py")
    regular(source)
    INSTALLED.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if INSTALLED.parent.is_symlink() or INSTALLED.parent.resolve() != INSTALLED.parent:
        raise SystemExit("Installed helper directory must not contain symlinks")
    if INSTALLED.parent.stat().st_uid != 0 or INSTALLED.parent.stat().st_mode & 0o022:
        raise SystemExit("Installed helper directory must be root owned and not writable by other users")

    service = f"""{MARKER}
[Unit]
Description=IMON Meets encrypted recording snapshot
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
WorkingDirectory={project}
ExecStart=/usr/bin/python3 {INSTALLED} --project {project} --recipient {RECIPIENT}
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=1200
MemoryMax=256M
CPUQuota=50%
TasksMax=64
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={project}/backups
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
"""
    timer = f"""{MARKER}
[Unit]
Description=IMON Meets recording backup every five minutes
[Timer]
OnCalendar=*-*-* *:00/5:00
AccuracySec=15s
RandomizedDelaySec=15s
Persistent=true
Unit={SERVICE}
[Install]
WantedBy=timers.target
"""
    unit_dir = pathlib.Path("/etc/systemd/system")
    for name in (SERVICE, TIMER):
        path = unit_dir / name
        if path.is_symlink() or (path.exists() and (not path.is_file() or MARKER not in path.read_text())):
            raise SystemExit(f"Refusing to overwrite an unmanaged unit: {name}")
    atomic_write(INSTALLED, source.read_bytes(), 0o755)
    atomic_write(unit_dir / SERVICE, service.encode(), 0o644)
    atomic_write(unit_dir / TIMER, timer.encode(), 0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=30)
    started = time.time()
    # This exercises the real systemd sandbox too. Scheduling remains disabled
    # for a first installation if snapshot creation or validation fails.
    subprocess.run(["systemctl", "start", SERVICE], check=True, timeout=1230)
    spec = importlib.util.spec_from_file_location("installed_recording_backup", INSTALLED)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    manifest = helper.validate_manifest(helper.read_json(project / "backups/recordings/manifest.json"))
    if manifest.get("complete") is not True or helper.timestamp(manifest["generatedAt"]).timestamp() < started - 1:
        raise SystemExit("First fresh recording snapshot failed; timer was not newly enabled")
    subprocess.run(["systemctl", "enable", "--now", TIMER], check=True, timeout=30)
    print(json.dumps({"installed": True, "timer": TIMER, "intervalSeconds": 300,
                      "recordings": len(manifest["objects"]), "firstSnapshotVerified": True}))


if __name__ == "__main__":
    main()
