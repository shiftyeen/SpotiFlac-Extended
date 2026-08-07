"""SpotiFLAC/core/cloudflare_tunnel.py — Automated Cloudflare Quick Tunnel launcher & 10-min keep-alive logger."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
import httpx

logger = logging.getLogger("SpotiFLAC.CloudflareTunnel")

_CLOUDFLARED_DIR = Path(__file__).resolve().parent.parent / ".cloudflared"
_SPAN_INTERVAL_SECONDS = 600  # 10 minutes


def _get_cloudflared_download_url() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    elif system == "linux":
        if "arm" in machine or "aarch64" in machine:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
        elif "64" in machine or "x86_64" in machine:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        else:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386"
    elif system == "darwin":
        if "arm" in machine or "aarch64" in machine:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64"
        else:
            return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64"
    return None


def ensure_cloudflared_binary() -> Path | None:
    """Returns path to executable cloudflared binary, downloading if missing."""
    # 1. System PATH check
    path_bin = shutil.which("cloudflared")
    if path_bin:
        return Path(path_bin)

    # 2. Local directory check
    _CLOUDFLARED_DIR.mkdir(parents=True, exist_ok=True)
    executable_name = "cloudflared.exe" if platform.system().lower() == "windows" else "cloudflared"
    local_bin = _CLOUDFLARED_DIR / executable_name

    if local_bin.exists() and local_bin.stat().st_size > 1000000:
        return local_bin

    url = _get_cloudflared_download_url()
    if not url:
        logger.error("[cloudflared] Unsupported platform for automatic binary download: %s-%s", platform.system(), platform.machine())
        return None

    print(f" [Cloudflare] Descargando ejecutable de Cloudflare Tunnel ({local_bin.name})...")
    try:
        with httpx.Client(timeout=60.0, follow_redirects=True) as client:
            resp = client.get(url)
            if resp.status_code == 200:
                local_bin.write_bytes(resp.content)
                if platform.system().lower() != "windows":
                    local_bin.chmod(local_bin.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
                print(" [Cloudflare] Ejecutable descargado correctamente.")
                return local_bin
    except Exception as exc:
        print(f" [Cloudflare] Error descargando cloudflared: {exc}")

    return None


class CloudflareTunnelManager:
    def __init__(self, port: int) -> None:
        self.port = port
        self.process: subprocess.Popen | None = None
        self.tunnel_url: str | None = None
        self._stop_event = threading.Event()
        self._spam_thread: threading.Thread | None = None

    def start(self) -> str | None:
        bin_path = ensure_cloudflared_binary()
    def start(self) -> str | None:
        bin_path = ensure_cloudflared_binary()
        if not bin_path:
            print(" [Cloudflare] No se pudo obtener el ejecutable de cloudflared.")
            return None

        cmd = [str(bin_path), "tunnel", "--url", f"http://localhost:{self.port}"]
        print(f" [Cloudflare] Iniciando tunel para el puerto {self.port}...")

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            # Read lines to extract trycloudflare.com URL
            start_time = time.time()
            url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

            while time.time() - start_time < 30.0:
                line = self.process.stdout.readline()
                if not line:
                    break
                match = url_pattern.search(line)
                if match:
                    self.tunnel_url = match.group(0)
                    break

            if self.tunnel_url:
                self._print_banner()
                # Start 10-minute recurring spam thread
                self._spam_thread = threading.Thread(target=self._spam_loop, daemon=True)
                self._spam_thread.start()
                return self.tunnel_url
            else:
                print(" [Cloudflare] No se obtuvo el enlace del tunel en 30 segundos.")
        except Exception as exc:
            print(f" [Cloudflare] Error ejecutando tunel: {exc}")

        return None

    def _print_banner(self) -> None:
        if not self.tunnel_url:
            return
        banner = f"""
================================================================
 ENLACE DE ACCESO PUBLICO (TUNEL CLOUDFLARE ACTIVO)
================================================================
 -> Web UI & API Public Link:
    {self.tunnel_url}

 -> Documentacion Swagger / OpenAPI Docs:
    {self.tunnel_url}/docs
================================================================
"""
        print(banner)
        sys.stdout.flush()

    def _spam_loop(self) -> None:
        while not self._stop_event.is_set():
            # Sleep for 10 minutes (checking stop_event every 5 seconds)
            for _ in range(_SPAN_INTERVAL_SECONDS // 5):
                if self._stop_event.is_set():
                    return
                time.sleep(5)

            if self.tunnel_url and not self._stop_event.is_set():
                print(f"\n [RECORDATORIO 10 MIN] Enlace activo del Tunel Cloudflare: {self.tunnel_url}\n")
                sys.stdout.flush()

    def stop(self) -> None:
        self._stop_event.set()
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2.0)
            except Exception:
                with contextlib.suppress(Exception):
                    self.process.kill()
