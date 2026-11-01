#!/usr/bin/env python3
"""Install a per-user LaunchAgent after the first verified HTTPS pull succeeds."""
import argparse
import datetime
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=pathlib.Path,
                    default=pathlib.Path.home() / ".local/state/imonmeets-backup")
args = parser.parse_args()
root = args.root.resolve()
if sys.platform != "darwin":
    raise SystemExit("This installer is for macOS")
os.umask(0o077)
root.mkdir(mode=0o700, parents=True, exist_ok=True)
root.chmod(0o700)
cfg = json.loads((root / "connection.json").read_text())
if not cfg.get("baseUrl") or not cfg.get("bearerToken"):
    raise SystemExit("Configure the HTTPS origin and private export token first")
for name in ["connection.json", "recipient.key", "recipient.pem"]:
    (root / name).chmod(0o600)
source = pathlib.Path(__file__).with_name("pull-encrypted-backup.py")
target = root / "pull.py"
if source.resolve() != target.resolve():
    shutil.copyfile(source, target)
target.chmod(0o700)
# Do not install an automatic job before transport, decryption and freshness pass.
started = time.time()
checked = subprocess.run([sys.executable, str(target)], timeout=650)
status = json.loads((root / "status.json").read_text())
checked_at = datetime.datetime.fromisoformat(status.get("checkedAt", "").replace("Z", "+00:00")).timestamp()
if checked.returncode not in {0, 1} or checked_at < started - 1 or not status.get("backupOk"):
    raise SystemExit("First verified backup failed; automatic job was not installed")
cfg["notifications"] = True
(root / "connection.json").write_text(json.dumps(cfg, indent=2) + "\n")
(root / "connection.json").chmod(0o600)
agent_dir = pathlib.Path.home() / "Library/LaunchAgents"
agent_dir.mkdir(parents=True, exist_ok=True)
plist = agent_dir / "world.imon.meets.backup-monitor.plist"
label = "world.imon.meets.backup-monitor"
data = {
    "Label": label,
    "ProgramArguments": [sys.executable, str(target)],
    "WorkingDirectory": str(root),
    "RunAtLoad": True,
    "StartInterval": 300,
    "EnvironmentVariables": {"IMON_AUTOMATED": "1"},
    "ProcessType": "Background",
    "LowPriorityIO": True,
    "Nice": 10,
    # Only private structured status files are kept; no unbounded stdout logs.
    "StandardOutPath": "/dev/null",
    "StandardErrorPath": "/dev/null",
}
with plist.open("wb") as handle:
    plistlib.dump(data, handle)
plist.chmod(0o600)
domain = f"gui/{os.getuid()}"
subprocess.run(["launchctl", "bootout", domain + "/" + label], capture_output=True)
subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
print(json.dumps({"installed": True, "label": label, "intervalSeconds": 300,
                  "requires": "Mac awake and user session active; notifications allowed for osascript"}))
