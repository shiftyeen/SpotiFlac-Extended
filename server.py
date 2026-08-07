"""server.py — Executable entrypoint for SpotiFLAC Music & Extension Server."""

import argparse
import asyncio
import os
import signal
import socket
import sys

os.environ["SPOTIFLAC_NON_INTERACTIVE"] = "1"

import uvicorn


def _get_accessible_urls(host: str, port: int) -> list[str]:
    """Resolves local, LAN, and PaaS environment URLs for direct access without tunnels."""
    urls = []

    # 1. Environment variables from PaaS (e.g. Hugging Face, Railway, Render, VPS)
    paas_url = os.environ.get("PUBLIC_URL") or os.environ.get("PAAS_URL") or os.environ.get("HOST_URL")
    if paas_url:
        urls.append(paas_url.rstrip("/"))

    space_host = os.environ.get("SPACE_HOST")
    if space_host:
        urls.append(f"https://{space_host}")

    # 2. Localhost
    urls.append(f"http://localhost:{port}")
    urls.append(f"http://127.0.0.1:{port}")

    # 3. Direct LAN / Network IP interface
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        net_ip = s.getsockname()[0]
        s.close()
        if net_ip and net_ip not in ("127.0.0.1", "0.0.0.0"):
            lan_url = f"http://{net_ip}:{port}"
            if lan_url not in urls:
                urls.append(lan_url)
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        host_ip = socket.gethostbyname(hostname)
        if host_ip and host_ip not in ("127.0.0.1", "0.0.0.0"):
            lan_url = f"http://{host_ip}:{port}"
            if lan_url not in urls:
                urls.append(lan_url)
    except Exception:
        pass

    return urls


def _make_shutdown_handler(server: uvicorn.Server):
    """Return a SIGINT/SIGTERM handler that gracefully stops uvicorn and
    kills any lingering Chrome solver processes.
    """
    def _handle(signum, frame):
        try:
            from SpotiFLAC.core.solver import _kill_all_chrome_solvers
            _kill_all_chrome_solvers()
        except Exception:
            pass
        server.should_exit = True

    return _handle


def main() -> None:
    default_host = os.environ.get("HOST", "0.0.0.0")
    default_port = int(os.environ.get("PORT", "8000"))

    parser = argparse.ArgumentParser(
        description="SpotiFLAC Extended — Servidor API REST de Descarga de Música y Metadatos"
    )
    parser.add_argument("--host", default=default_host, help=f"Dirección host del servidor (defecto: {default_host})")
    parser.add_argument("--port", type=int, default=default_port, help=f"Puerto del servidor (defecto: {default_port})")
    parser.add_argument("--reload", action="store_true", help="Habilitar recarga automática para desarrollo")
    args = parser.parse_args()

    urls = _get_accessible_urls(args.host, args.port)
    primary_url = urls[0] if urls else f"http://localhost:{args.port}"

    print("\n" + "=" * 64)
    print(" 🚀 SpotiFLAC Extended Server — PaaS & VPS Production Ready")
    print("=" * 64)
    print(" 📌 Direcciones de acceso directo (Sin Túneles):")
    for url in urls:
        print(f"    ➜  {url}")
    print("\n 📖 Documentación OpenAPI / Swagger Docs:")
    print(f"    ➜  {primary_url}/docs")
    print("=" * 64 + "\n")

    config = uvicorn.Config(
        "SpotiFLAC.server.api:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )
    server = uvicorn.Server(config)

    handler = _make_shutdown_handler(server)
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)

    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
