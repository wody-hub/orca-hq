"""A real terminal: submit, type through a notification, submit again, detach."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

transcript = b""
cursor = 0
reaped = False

def read_until(marker):
    global transcript, cursor
    needle = marker.encode("utf-8")
    deadline = time.monotonic() + 5
    while True:
        found = transcript.find(needle, cursor)
        if found >= 0:
            cursor = found + len(needle)
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("PTY timeout: " + transcript.decode("utf-8", "replace"))
        readable, _, _ = select.select([terminal], [], [], 0.05)
        if readable:
            chunk = os.read(terminal, 65536)
            if not chunk:
                raise RuntimeError("PTY closed before " + marker)
            transcript += chunk

try:
    read_until("> ")
    os.write(terminal, "첫 질문\n".encode("utf-8"))
    read_until("접수 완료")
    read_until("> ")
    os.write(terminal, "두 번째".encode("utf-8"))
    read_until("확인 요청")
    os.write(terminal, " 질문\n".encode("utf-8"))
    read_until("접수 완료")
    os.write(terminal, b"/exit\n")
    read_until("진행 창은 계속됩니다")
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            reaped = True
            if os.waitstatus_to_exitcode(status) != 0:
                raise RuntimeError("Child failed")
            break
        time.sleep(0.01)
    if not reaped:
        raise RuntimeError("Chat did not detach from unfinished work")
    print(json.dumps({"output": transcript.decode("utf-8", "replace")}, ensure_ascii=False))
finally:
    if not reaped:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
