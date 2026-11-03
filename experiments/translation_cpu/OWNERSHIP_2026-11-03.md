# Owned native worker lifecycle, 3 November 2026

Base: `361b996bbf779b5550ddea67c1d40ba94f644dfa`. This is a separate fix after the participant-connection repair. It changes only the experimental Linux process boundary. No model, voice, audio, production setting or prior benchmark output is changed.

## Defect and failing evidence

The original `ProcessStage._stop()` used `asyncio.Process.wait()` and then signaled a numeric PGID. Asyncio's child watcher could already have reaped the leader. The number was no longer a retained ownership anchor. An idle worker that had exited before cleanup had the same initial-signal risk. The previous descendant test proved ordinary cleanup, not safety against identifier reuse.

`data/review_20261103/ownership_before_fix.py` preserves the exact initial failing test. Receipt `imonmeets-mt-ownership-red-20261103T093224Z-1792725` shows TERM before reap but KILL after reap, violating the required order. The test used a fixture and intercepted signals; it did not harm or signal an unrelated real process.

## Explicit supported contract

- Linux with `pidfd_open`, `waitid(P_PIDFD)` and `WNOWAIT`.
- This service is the sole reaper of each worker. There must be no external SIGCHLD handler, generic `waitpid(-1)` loop, automatic child watcher for these worker PIDs, or separate code calling Popen `poll`, `wait` or `communicate`.
- The worker runs in a fresh session/process group created by `Popen(start_new_session=True)`. The scope is that original process group, not arbitrary descendants that escape using `setsid`/`setpgid` or daemonize.
- The enclosing finite resource cgroup remains required. The process wrapper does not allocate new cgroups or require added privileges.
- This is an internal trusted ASR/MT executable boundary. It does not provide an untrusted arbitrary-code execution sandbox.

Unsupported platforms and a visible non-default SIGCHLD handler fail before spawning. `ECHILD` during observation sets permanent ownership loss before any future observation, removes signaling authority, closes admission and closes pipe/pidfd descriptors without signals or wait. The process/reservation remains quarantined. No subsequent retry falls back to numeric P_PID. The SIGCHLD check cannot detect arbitrary concurrent code calling waitpid; such code is explicitly prohibited by the sole-reaper contract. Production integration must keep this ownership boundary isolated from other child-management libraries.

## Implementation

`owned_process.py` holds a strong reference to a `subprocess.Popen` object. Unlike `asyncio.create_subprocess_exec`, it registers no asyncio child watcher. The pidfd is opened while the direct child is still owned and unreaped. Even an instantly exited child remains a zombie owned by this process until explicit reap.

`wait_exited()` uses pidfd readiness and `waitid(..., WNOWAIT | WNOHANG)`. It observes exit without consuming the child. `signal_group()` verifies the retained child and refuses a reaped handle. Cleanup follows this order:

1. Close stdin and cancel admitted request futures through the existing stage ownership lock.
2. Signal TERM to the original owned group.
3. Wait for leader exit up to the TERM grace, without reaping.
4. Signal KILL to the same group while the original leader is still live or retained as a zombie. Its PID has not been returned for reuse.
5. Wait for exit within the finite reap deadline, then perform the sole actual Popen wait/reap.
6. Drain stdout to EOF within a separate finite deadline and close stream descriptors and pidfd.

No group signal follows actual reap. A repeated successful close is a no-op. The source never calls Popen poll/communicate. Popen wait is confined to the final observed-exit reap.

The existing cancellation-during-spawn ownership loop is preserved around the new factory. If setup fails after Popen succeeds, `OwnedSpawnError` carries the still-owned process back to the stage, which cleans it up before releasing its reservation. A synchronous executable-spawn failure has no worker handle and releases the ordinary admission counters.

## Bounded I/O and failure behavior

Input remains bounded by the stage's serialized-request and aggregate-byte limits. Only one serialized request owns a worker at a time. Stdout reads retain at most the configured response cap plus one sentinel byte, and reads/writes are nonblocking. Stderr remains `/dev/null`, so it cannot build an unbounded captured buffer.

Shutdown discards at most 1 MiB in 16 KiB chunks and has `reap_timeout_seconds` as its deadline. The drain is independent of the leader wait. A descendant outside the process group can keep stdout open after leader exit; this returns a finite `StageCleanupError`, closes pipes, retains the native reservation and permanently closes admission. It never guesses or signals the escaped process's PID. The test fixture separately cleans its own escaped child using a captured pidfd.

On a failed wait before reap, the direct-child handle, pidfd and bounded stdout descriptor remain quarantined for a later explicit cleanup attempt. There is no replacement spawn. Once exit is proven, a retry can finish the reap and release the reservation. On an escaped-pipe failure after reap, cleanup cannot infer arbitrary-tree termination; the stage remains permanently quarantined even if an external owner later clears the child. These are explicit retained resources, not a successful-cleanup claim.

The wrapper reaps its direct child. It does not claim wait/reap ownership of grandchildren. Same-group descendants receive KILL; the real-child test verifies termination via their captured pidfd, allowing init to reap them separately.

## Verification

The new named regressions cover:

- No TERM/KILL after actual leader reap, including a reused numeric identifier fixture.
- Already exited leader retained as a zombie while a TERM-ignoring descendant holds stdout. Group cleanup stops the descendant and reaps the leader without leaking pipes/pidfd.
- External-reaper `ECHILD`: no signals, closed admission and retained quarantine.
- Escaped `setsid` descendant holding stdout: bounded error, closed descriptors, no replacement and fixture cleanup by pidfd.
- Synchronous spawn throw and pidfd initialization failure after successful spawn.
- Non-Linux and non-default SIGCHLD rejection before Popen.

The existing cancellation-during-spawn and failed-reap tests use the new factory and non-reaping observation method. Their behavioral assertions are unchanged. The existing timeout, response cap, wrong response ID, active/queued cancellation, descendant, reconnect, reservation and participant tests remain in the suite.

Completed runs, all under the shared verify.lock, CPUQuota=100%, MemoryMax=2 GiB, TasksMax=128:

| Receipt | Result | Scope |
| --- | --- | --- |
| ownership-red-20261103T093224Z-1792725 | 1 expected failing regression | Original post-reap signal ordering |
| ownership-focused-20261103T093348Z-1804947 | 10/10 pass, 1.093 s | Initial new boundary plus previous process tests |
| ownership-new-regressions-20261103T093624Z-1827254 | 8/8 pass, 0.399 s | New ownership and real-child cases |
| ownership-full-control-20261103T093642Z-1829963 | 101/101 pass, 21.018 s | Complete suite before the terminal ECHILD descriptor follow-up |
| ownership-terminal-fds-20261103T094113Z-1870215 | 8/8 pass, 0.427 s | Final ownership source, including actual external fixture reap and sticky FD cleanup |

The full suite used finite RuntimeMaxSec=90 and exited 0. Independent read-only review then requested closing descriptors after irreversible ownership loss; the final focused run used RuntimeMaxSec=30 and exited 0. Its 52.88 s launcher wall time includes the shared-lock wait, not 52.88 s of test execution. The full suite is not relabeled as a run of the follow-up source. Exact source and receipt hashes are separate in `data/review_20261103/ownership_source_and_evidence.json` and `ownership_terminal_source_and_evidence.json`. Every pre-existing tracked raw evidence file still matches the previous commit. Earlier failed/control runs remain separate; no receipt is overwritten.

This verification uses actual OS subprocesses with protocol fixtures, not the speech models. The historical real model lifecycle trace is still historical; it was not rerun or relabeled for this change. MT quality, RU↔ZH/AR acceptance, TTS rights, live audio, listener routing, privacy and commercial integration remain open.
