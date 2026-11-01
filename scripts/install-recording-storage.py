#!/usr/bin/env python3
"""Install a dedicated, hard-bounded recordings filesystem. Fixed paths only.

Never formats an existing file or device. A failed unmount leaves a mode 000
bare mountpoint so the unprivileged storage process cannot fill the host disk.
"""
import json
import os
import pathlib
import stat
import subprocess

IMAGE = pathlib.Path("/var/lib/imonmeets/recordings.ext4")
TARGET = pathlib.Path("/home/sergey/.local/share/imonmeets-recordings")
SIZE = 1024 ** 3
UID = GID = 1000
LABEL = "imon-recordings"


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60).stdout.strip()


def no_symlink_components(path):
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise RuntimeError("Storage paths must not contain symlinks")


def mounted_source(target):
    result = subprocess.run(
        ["findmnt", "--json", "--mountpoint", str(target), "--output", "TARGET,SOURCE,FSTYPE,OPTIONS"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode == 1:
        return None
    if result.returncode != 0:
        raise RuntimeError("Cannot inspect current mounts")
    mounts = json.loads(result.stdout).get("filesystems", [])
    if len(mounts) != 1 or mounts[0].get("target") != str(target):
        raise RuntimeError("Unexpected mount identity")
    return mounts[0]


def validate_mounted(mount):
    if mount.get("fstype") != "ext4":
        raise RuntimeError("Recording mount is not ext4")
    loops = json.loads(run(["losetup", "--json", "--list", "--output", "NAME,BACK-FILE"]))
    match = [entry for entry in loops.get("loopdevices", [])
             if entry.get("name") == mount.get("source")]
    if len(match) != 1 or match[0].get("back-file") != str(IMAGE):
        raise RuntimeError("Recording mount uses a different backing file")
    if not {"nodev", "nosuid", "noexec"}.issubset(set(mount.get("options", "").split(","))):
        raise RuntimeError("Recording mount lacks required restrictions")
    info = os.statvfs(TARGET)
    total = info.f_blocks * info.f_frsize
    if not int(0.8 * SIZE) <= total <= int(1.1 * SIZE):
        raise RuntimeError("Recording filesystem size is outside the approved bound")
    return total


def validate_image(image=IMAGE):
    info = image.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError("Existing image must be one regular file, not a link or device")
    if info.st_size != SIZE or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("Existing image must be exactly 1 GiB, root owned and mode 0600")
    fields = dict(line.split("=", 1) for line in run(["blkid", "-p", "-o", "export", str(image)]).splitlines() if "=" in line)
    if fields.get("TYPE") != "ext4" or fields.get("LABEL") != LABEL:
        raise RuntimeError("Existing image is not the expected recordings ext4 filesystem; it will not be formatted")


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run with sudo")
    os.umask(0o077)
    no_symlink_components(IMAGE)
    no_symlink_components(TARGET)
    # Check before any writes. A fully allocated new 1 GiB image must still leave
    # at least 5 GiB free on the host, irrespective of its initially sparse size.
    parent = IMAGE.parent if IMAGE.parent.exists() else IMAGE.parent.parent
    disk = os.statvfs(parent)
    free = disk.f_bavail * disk.f_frsize
    if free < 6 * SIZE:
        raise SystemExit("At least 6 GiB free host space is required before provisioning")
    before = mounted_source(TARGET)
    if before is not None:
        validate_image()
        validate_mounted(before)
    elif TARGET.exists():
        if not TARGET.is_dir() or any(TARGET.iterdir()):
            raise SystemExit("Existing recording mountpoint is not an empty directory")
    if IMAGE.exists():
        validate_image()
        if before is None:
            loops = json.loads(run(["losetup", "--json", "--list", "--output", "NAME,BACK-FILE"]))
            if any(entry.get("back-file") == str(IMAGE) for entry in loops.get("loopdevices", [])):
                raise SystemExit("Existing image is already attached elsewhere; no filesystem check or mount was attempted")
            # Read-only check only. Do not repair, resize or format existing data.
            run(["e2fsck", "-f", "-n", str(IMAGE)])
    else:
        if before is not None:
            raise SystemExit("Unexpected mount without its backing image")
        IMAGE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        no_symlink_components(IMAGE)
        parent_info = IMAGE.parent.stat()
        if parent_info.st_uid != 0 or stat.S_IMODE(parent_info.st_mode) & 0o022:
            raise SystemExit("Image directory must be root owned and not writable by other users")
        # O_EXCL is the only creation path. Formatting is strictly within this
        # successful-create branch, never a retry against an existing image.
        fd = os.open(IMAGE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as image:
            os.fchown(image.fileno(), 0, 0)
            os.ftruncate(image.fileno(), SIZE)
            os.fsync(image.fileno())
        run(["mkfs.ext4", "-F", "-q", "-m", "0", "-L", LABEL,
             "-E", "lazy_itable_init=0,lazy_journal_init=0", str(IMAGE)])
        validate_image()
    if before is None:
        TARGET.mkdir(mode=0o000, parents=True, exist_ok=True)
        os.chown(TARGET, 0, 0)
        TARGET.chmod(0o000)
    unit_name = run(["systemd-escape", "--path", "--suffix=mount", str(TARGET)])
    if not unit_name.endswith(".mount") or "/" in unit_name or "\n" in unit_name:
        raise RuntimeError("Invalid escaped systemd unit name")
    unit = pathlib.Path("/etc/systemd/system") / unit_name
    if unit.is_symlink():
        raise RuntimeError("Refusing a symlinked mount unit")
    marker = "# Managed by IMON Meets recording storage installer"
    if unit.exists() and not unit.read_text().startswith(marker + "\n"):
        raise RuntimeError("Refusing to replace an unrelated existing mount unit")
    unit.write_text(f"""{marker}
[Unit]
Description=IMON Meets bounded private recording storage
Before=docker.service

[Mount]
What={IMAGE}
Where={TARGET}
Type=ext4
Options=loop,nodev,nosuid,noexec
TimeoutSec=30

[Install]
WantedBy=multi-user.target
""")
    unit.chmod(0o644)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", unit_name])
    mount = mounted_source(TARGET)
    if mount is None:
        raise RuntimeError("Recording filesystem did not mount")
    total = validate_mounted(mount)
    os.chown(TARGET, UID, GID)
    TARGET.chmod(0o700)
    # Directory inherited from mkfs is not needed by the object store. Keep it
    # private but do not recursively modify or remove any existing data.
    post = os.statvfs(IMAGE.parent)
    allocated = IMAGE.stat().st_blocks * 512
    worst_case_free = post.f_bavail * post.f_frsize - max(0, SIZE - allocated)
    if worst_case_free < 5 * SIZE:
        raise RuntimeError("Host headroom changed during provisioning; do not start recording storage")
    print(json.dumps({"mounted": True, "mountUnit": unit_name,
                      "filesystemBytes": total, "imageBytes": SIZE,
                      "worstCaseHostFreeGiB": round(worst_case_free / SIZE, 2),
                      "owner": "1000:1000", "mode": "0700"}))


if __name__ == "__main__":
    main()
