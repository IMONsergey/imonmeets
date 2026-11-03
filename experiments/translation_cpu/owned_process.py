"""Linux worker ownership with a leader retained until group signaling ends.

This service must be the sole reaper of its workers. No asyncio child watcher,
SIGCHLD handler, external waitpid(-1), poll(), wait() or communicate() may reap
these Popen children. pidfd/waitid(WNOWAIT) observes exit without consuming it.

The contract covers the original process group. A descendant that escapes with
setsid/setpgid is not an owned group member; a retained stdout pipe fails closed.
The surrounding finite cgroup remains required. This is not an arbitrary tree
killer and does not claim reaping of grandchildren.
"""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys


class ProcessOwnershipError(RuntimeError):
    pass


class ProcessOwnershipLostError(ProcessOwnershipError):
    """An external reaper consumed the child; authority cannot be recovered."""
    pass


class OwnedSpawnError(RuntimeError):
    def __init__(self, process, cause):
        super().__init__("worker setup failed after spawn; ownership retained")
        self.process = process
        self.__cause__ = cause


def require_owned_process_support():
    required = ("pidfd_open", "P_PIDFD", "waitid", "WNOWAIT", "WEXITED", "WNOHANG")
    if sys.platform != "linux" or not all(hasattr(os, key) for key in required):
        raise ProcessOwnershipError("Linux pidfd and non-reaping waitid are required")
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise ProcessOwnershipError("exclusive child reaping requires default SIGCHLD")


class _Readiness:
    """One watcher owned by this descriptor object, removed before FD close."""
    def __init__(self, fd, *, writable=False):
        self.fd, self.writable = fd, writable
        self.waiter = None
        self.closed = False

    async def wait(self):
        if self.closed:
            raise BrokenPipeError("descriptor is closed")
        if self.waiter is not None:
            raise RuntimeError("concurrent waits on one owned descriptor")
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.waiter = future
        def ready():
            if not future.done():
                future.set_result(None)
        add = loop.add_writer if self.writable else loop.add_reader
        remove = loop.remove_writer if self.writable else loop.remove_reader
        added = False
        try:
            add(self.fd, ready)
            added = True
            await future
        finally:
            if self.waiter is future:
                if added:
                    remove(self.fd)
                self.waiter = None

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.waiter is not None:
            loop = asyncio.get_running_loop()
            remove = loop.remove_writer if self.writable else loop.remove_reader
            remove(self.fd)
            waiter, self.waiter = self.waiter, None
            if not waiter.done():
                waiter.set_exception(BrokenPipeError("descriptor closed during wait"))


class _InputPipe:
    def __init__(self, stream):
        self.stream = stream
        self.ready = _Readiness(stream.fileno(), writable=True)
        os.set_blocking(stream.fileno(), False)
        self.pending = None

    def write(self, payload):
        if self.stream.closed:
            raise BrokenPipeError("worker input is closed")
        if self.pending is not None:
            raise RuntimeError("drain previous input before writing again")
        self.pending = memoryview(payload)

    async def drain(self):
        while self.pending:
            if self.stream.closed or self.ready.closed:
                raise BrokenPipeError("worker input is closed")
            try:
                written = os.write(self.ready.fd, self.pending)
            except BlockingIOError:
                await self.ready.wait()
                continue
            if not written:
                raise BrokenPipeError("worker input accepted no bytes")
            self.pending = self.pending[written:]
        self.pending = None

    def close(self):
        self.ready.close()
        self.pending = None
        self.stream.close()


class _OutputPipe:
    def __init__(self, stream, limit):
        self.stream, self.limit = stream, limit
        self.ready = _Readiness(stream.fileno())
        os.set_blocking(stream.fileno(), False)
        self.buffer = bytearray()
        self.eof = False

    async def _read(self, size):
        while True:
            if self.stream.closed or self.ready.closed:
                raise BrokenPipeError("worker output is closed")
            try:
                data = os.read(self.ready.fd, size)
                if not data:
                    self.eof = True
                return data
            except BlockingIOError:
                await self.ready.wait()

    async def readline(self):
        while True:
            end = self.buffer.find(b"\n")
            if end >= 0:
                line = bytes(self.buffer[:end + 1])
                del self.buffer[:end + 1]
                return line
            if len(self.buffer) >= self.limit:
                raise ValueError("worker output byte cap")
            if self.eof:
                line = bytes(self.buffer)
                self.buffer.clear()
                return line
            self.buffer.extend(await self._read(min(16384, self.limit - len(self.buffer))))

    async def drain_eof(self):
        # Discard at most 1 MiB on shutdown with a fixed-size temporary buffer.
        # A separate caller deadline bounds a descendant that keeps the pipe open.
        discarded = len(self.buffer)
        self.buffer.clear()
        while not self.eof:
            if discarded >= 1024 * 1024:
                raise ProcessOwnershipError("shutdown output drain cap exceeded")
            discarded += len(await self._read(min(16384, 1024 * 1024 - discarded)))

    def close(self):
        self.ready.close()
        self.buffer.clear()
        self.stream.close()


class OwnedProcess:
    def __init__(self):
        self._popen = None
        self._pidfd = None
        self._pid_ready = None
        self.stdin = self.stdout = None
        self.reaped = False
        self.ownership_lost = False
        self.unproven_descendants = False
        self.returncode = None

    @property
    def pid(self):
        return self._popen.pid

    def _observe(self):
        if self.ownership_lost:
            raise ProcessOwnershipLostError("worker ownership was permanently lost")
        require_owned_process_support()
        if self.reaped:
            raise ProcessOwnershipError("leader was already reaped; numeric group is no longer owned")
        try:
            return os.waitid(os.P_PIDFD if self._pidfd is not None else os.P_PID,
                             self._pidfd if self._pidfd is not None else self.pid,
                             os.WEXITED | os.WNOWAIT | os.WNOHANG)
        except ChildProcessError as error:
            self.ownership_lost = True
            raise ProcessOwnershipLostError("another reaper consumed the worker; no signaling authority") from error

    def signal_group(self, sig):
        # Sole-reaper contract: this direct child stays live or zombie until reap().
        # Its numeric PID cannot be reused while held, including across awaits.
        self._observe()
        try:
            os.killpg(self.pid, sig)
        except ProcessLookupError:
            pass

    async def wait_exited(self):
        while True:
            status = self._observe()
            if status is not None:
                return status
            if self._pid_ready is not None:
                await self._pid_ready.wait()
            else:
                # pidfd setup failed after spawn. The unreaped owned child is
                # still retained; finite cleanup may observe it without reaping.
                await asyncio.sleep(.005)

    def reap(self):
        if self._observe() is None:
            raise ProcessOwnershipError("refusing a blocking reap before observed exit")
        # Only this line consumes the direct child, after the last group signal.
        self.returncode = self._popen.wait(timeout=0)
        self.reaped = True
        self._close_pidfd()
        return self.returncode

    def _close_pidfd(self):
        if self._pid_ready is not None:
            self._pid_ready.close()
            self._pid_ready = None
        if self._pidfd is not None:
            os.close(self._pidfd)
            self._pidfd = None

    def close_lost_observation(self):
        """Drop unusable descriptors without signaling or claiming reclamation."""
        if not self.ownership_lost:
            raise ProcessOwnershipError("only lost ownership permits abandonment")
        try:
            self.close_pipes()
        finally:
            self._close_pidfd()

    def close_pipes(self):
        for pipe in (self.stdin, self.stdout):
            if pipe is not None:
                pipe.close()
        # Cover setup failure between Popen and wrapper initialization.
        if self._popen is not None:
            for stream in (self._popen.stdin, self._popen.stdout):
                if stream is not None and not stream.closed:
                    stream.close()


async def spawn_owned_process(command, *, environment, max_output_bytes):
    require_owned_process_support()
    process = OwnedProcess()
    try:
        process._popen = subprocess.Popen(command, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         bufsize=0, start_new_session=True, env=environment)
        # No child watcher exists for this Popen. Even an instantly exited worker
        # remains our unreaped child while pidfd is acquired.
        process._pidfd = os.pidfd_open(process.pid)
        process._pid_ready = _Readiness(process._pidfd)
        process.stdin = _InputPipe(process._popen.stdin)
        process.stdout = _OutputPipe(process._popen.stdout, max_output_bytes + 1)
        return process
    except BaseException as error:
        if process._popen is not None:
            raise OwnedSpawnError(process, error) from error
        raise
