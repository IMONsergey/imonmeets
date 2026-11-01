# Bounded recording storage

`scripts/install-recording-storage.py` installs one dedicated ext4 filesystem for
the local recording object store. It uses fixed paths:

| Item                      | Value                                            |
| ------------------------- | ------------------------------------------------ |
| Sparse backing image      | `/var/lib/imonmeets/recordings.ext4`             |
| Exact image limit         | 1 GiB                                            |
| Mountpoint                | `/home/sergey/.local/share/imonmeets-recordings` |
| Mounted owner and mode    | `1000:1000`, `0700`                              |
| Bare, unmounted directory | root owned, `000`                                |

Run `sudo python3 scripts/install-recording-storage.py`. The installer requires
at least 6 GiB free on the image's host filesystem before writing. It also checks
that complete allocation of the image would leave at least 5 GiB free. A sparse
file saves initial allocation but never increases the 1 GiB hard bound.

Formatting occurs only immediately after an exclusive creation of a new regular
file. Existing images are never formatted, repaired or resized. An existing image
must already have the exact approved size, root ownership, mode 0600, ext4 type
and `imon-recordings` label. A stopped existing filesystem receives a read-only
filesystem check. Unexpected mounts, symlinks and nonempty bare mountpoints are
refused. The installer does not delete recording data.

The dedicated systemd `.mount` unit is named with `systemd-escape`, enabled for
boot and uses `loop,nodev,nosuid,noexec`. It is ordered before Docker with a
30-second mount timeout. It does not add a `Requires` or `Wants` dependency to
the Docker service, restart Docker or modify other containers. A failure does
not add a failure dependency to other Docker applications.

When the filesystem is absent, the bare mode 000 mountpoint prevents the storage
process running as UID 1000 from writing into the general host filesystem. The
storage container must also verify the expected filesystem bound before starting.
Do not start the storage container as root or remove that check. Do not unmount
this filesystem while the recording storage service is running.

The mounted capacity is verified through `findmnt`, the loop device's backing
file and `statvfs`, accepting only 0.8 to 1.1 GiB of filesystem capacity. The
capacity includes filesystem and object-store metadata, so usable recording
space is less than 1 GiB. Retention and admission checks should stop new recordings
before this filesystem fills. This isolated limit protects the host filesystem;
it does not itself create an off-host backup of recording objects.

The encrypted database recovery bundle also includes the private app/admin S3
credentials from `deploy/recording-private/credentials.json` when that file
exists. The MP4 objects themselves are not included in this backup. Preserving
credentials supports recovery but does not restore a lost recording filesystem.
