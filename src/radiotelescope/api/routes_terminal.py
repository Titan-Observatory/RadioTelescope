from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["terminal"])


@router.websocket("/ws/terminal")
async def terminal_ws(ws: WebSocket):
    await ws.accept()
    cfg = ws.app.state.config.terminal
    if not cfg.enabled:
        await ws.send_text("Terminal is disabled in config.\r\n")
        await ws.close()
        return

    shell = cfg.shell or _default_shell()
    if os.name == "nt":
        await _pipe_terminal(ws, shell)
    else:
        await _pty_terminal(ws, shell)


async def _pipe_terminal(ws: WebSocket, shell: str) -> None:
    args = [shell]
    shell_name = Path(shell).name.lower()
    if shell_name.startswith("powershell") or shell_name.startswith("pwsh"):
        args.append("-NoLogo")

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=Path.cwd(),
    )

    async def read_loop() -> None:
        assert proc.stdout is not None
        while True:
            data = await proc.stdout.read(4096)
            if not data:
                break
            await ws.send_text(data.decode(errors="replace"))

    async def write_loop() -> None:
        assert proc.stdin is not None
        while True:
            text = await ws.receive_text()
            proc.stdin.write(text.encode())
            await proc.stdin.drain()

    try:
        await asyncio.gather(read_loop(), write_loop())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                proc.kill()


async def _pty_terminal(ws: WebSocket, shell: str) -> None:
    import pty

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        [shell],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=Path.cwd(),
        close_fds=True,
    )
    os.close(slave_fd)

    async def read_loop() -> None:
        while True:
            data = await asyncio.to_thread(os.read, master_fd, 4096)
            if not data:
                break
            await ws.send_text(data.decode(errors="replace"))

    async def write_loop() -> None:
        while True:
            text = await ws.receive_text()
            await asyncio.to_thread(os.write, master_fd, text.encode())

    try:
        await asyncio.gather(read_loop(), write_loop())
    except (WebSocketDisconnect, asyncio.CancelledError, OSError):
        pass
    finally:
        if proc.poll() is None:
            proc.terminate()
        os.close(master_fd)


def _default_shell() -> str:
    if os.name == "nt":
        return shutil.which("powershell.exe") or shutil.which("pwsh.exe") or "cmd.exe"
    return os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
