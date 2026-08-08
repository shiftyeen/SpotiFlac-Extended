"""SpotiFLAC/server/api.py — Comprehensive REST API and WebSocket Server for SpotiFLAC Extended."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import time
import urllib.parse
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from SpotiFLAC.client import AsyncSpotiFLAC
from SpotiFLAC.core import signed_session_mobile
from SpotiFLAC.core.artwork_api import fetch_animated_artwork, fetch_itunes_3000x_cover_url
from SpotiFLAC.core.health_check import run_health_check
from SpotiFLAC.extensions.manager import ExtensionManager
from SpotiFLAC.server.task_manager import TaskManager

logger = logging.getLogger("SpotiFLAC.server")

SERVER_START_TIME = time.time()
TEMP_DOWNLOAD_DIR = os.path.join(os.getcwd(), "temp_downloads")
STATIC_INDEX_PATH = Path(__file__).parent / "static" / "index.html"
PROVIDERS_CONFIG_FILE = Path(__file__).parent.parent / "providers_config.json"

tags_metadata = [
    {
        "name": "Search & Metadata",
        "description": "Búsqueda de canciones, autocompletado en tiempo real, metadatos enriquecidos, portadas 3000x HD y letras sincronizadas.",
    },
    {
        "name": "Downloads & Tasks",
        "description": "Creación y seguimiento de tareas de descarga en segundo plano con soporte de WebSockets.",
    },
    {
        "name": "Providers & Capabilities",
        "description": "Información detallada de proveedores nativos y extensión, calidad soportada y diagnóstico de salud.",
    },
    {
        "name": "Extensions System",
        "description": "Gestión del registro oficial de extensiones JS, instalación, actualización y configuración.",
    },
    {
        "name": "Sessions & Verification",
        "description": "Manejo de tokens de verificación Cloudflare Turnstile e intercambio de grants.",
    },
]

app = FastAPI(
    title="SpotiFLAC Extended Engine API",
    description="""
# SpotiFLAC Extended REST API
API REST y WebSockets de alto rendimiento para descarga de audio Lossless FLAC / Hi-Res desde múltiplos proveedores (Tidal, Qobuz, Amazon Music, Deezer, YouTube Music, SoundCloud, Pandora).

### Características Principales:
* **Metadatos en Tiempo Real**: Resolución instantánea de pistas, álbumes y playlists con portadas iTunes 3000x3000px y animación Apple Music.
* **Sistema de Extensiones JS**: Soporte para extensiones dinámicas sincronizadas con el registro oficial.
* **Autenticación Turnstile Automatizada**: Bypass y manejo transparente de desafíos Cloudflare.
* **WebSockets**: Streaming de progreso y logs en tiempo real para clientes web o bots.
""",
    version="1.6.0",
    openapi_tags=tags_metadata,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Enable CORS for remote clients / frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

task_manager = TaskManager(default_output_dir=TEMP_DOWNLOAD_DIR)
extension_manager = ExtensionManager(auto_install_downloads=False)


# ─── Web UI Solver Interceptor ────────────────────────────────

class WebUISolver:
    def __init__(self):
        self.pending_grants: Dict[str, asyncio.Future] = {}

    async def solver_grant_async(self, challenge_url: str):
        state = "zarz-v2"
        try:
            parsed = urllib.parse.urlparse(challenge_url)
            query = urllib.parse.parse_qs(parsed.query)
            original_cb = query.get("cb", [""])[0]
            if original_cb:
                cb_parsed = urllib.parse.urlparse(original_cb)
                cb_qs = urllib.parse.parse_qs(cb_parsed.query)
                state = cb_qs.get("state", [""])[0] or state

            future = asyncio.Future()
            self.pending_grants[state] = future

            for task in task_manager._tasks.values():
                if task.status == "running":
                    task_manager.add_log(task, f"[signed_session] Verification required: {challenge_url}")

            grant = await asyncio.wait_for(future, timeout=300)
            return grant
        except Exception:
            self.pending_grants.pop(state, None)
            raise

web_ui_solver = WebUISolver()
signed_session_mobile._solver_grant_async = web_ui_solver.solver_grant_async


@app.on_event("startup")
async def on_startup() -> None:
    task_manager.start_periodic_cleanup()
    try:
        await asyncio.to_thread(
            extension_manager.ensure_download_providers,
            force_update=True,
        )
    except Exception:
        pass


@app.get("/", response_class=HTMLResponse, summary="Interfaz Web de SpotiFLAC (Apple Music Theme)")
async def get_index() -> HTMLResponse:
    if STATIC_INDEX_PATH.exists():
        return HTMLResponse(content=STATIC_INDEX_PATH.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>SpotiFLAC Extended Server Running</h1>")


# ─── Pydantic Models ──────────────────────────────────────────

class DownloadRequest(BaseModel):
    url: str = Field(..., example="https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", description="URL o URI de Spotify, Apple Music, Tidal, Deezer, YouTube, SoundCloud o Pandora")
    output_dir: Optional[str] = Field(None, description="Directorio de destino opcional")
    services: Optional[List[str]] = Field(
        default=["ext:qobuz-web", "amazon", "ext:tidal-web", "qobuz", "deezer", "tidal", "youtube"],
        description="Lista prioritaria de proveedores a consultar"
    )
    quality: str = Field("LOSSLESS", example="HI_RES_LOSSLESS", description="Calidad esperada: DOLBY_ATMOS, HI_RES_LOSSLESS, LOSSLESS, HIGH, LOW")
    embed_lyrics: bool = Field(True, description="Embeber letras sincronizadas en la pista audio")
    enrich_metadata: bool = Field(True, description="Enriquecer metadatos con iTunes / Apple Music / MusicBrainz")
    filename_format: str = Field("{title} - {artist}", description="Formato de plantilla para el nombre de archivo")


class InstallExtensionRequest(BaseModel):
    download_url_or_id: str = Field(..., example="tidal-web", description="ID de la extensión en el registro o URL directa al archivo .sflx")


class SaveSettingsRequest(BaseModel):
    settings: Dict[str, Any] = Field(..., description="Diccionario clave-valor con la configuración de la extensión")


class SessionGrantRequest(BaseModel):
    namespace: str = Field("zarz-v2", description="Namespace de la sesión firmada")
    grant: str = Field(..., description="Token 'grant' o de callback devuelto tras resolver la verificación Cloudflare")


# ─── Providers & Capabilities Endpoints ────────────────────────

@app.get("/api/v1/providers/capabilities", tags=["Providers & Capabilities"], summary="Obtener capacidades de proveedores y calidades soportadas")
async def get_providers_capabilities() -> Dict[str, Any]:
    """Retorna la matriz completa de configuración de proveedores nativos y extensiones con sus calidades soportadas."""
    if PROVIDERS_CONFIG_FILE.exists():
        try:
            return json.loads(PROVIDERS_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning(f"Error leyendo providers_config.json: {exc}")
    return {"providers": []}


@app.get("/api/v1/providers", tags=["Providers & Capabilities"], summary="Listar todos los proveedores instalados y su estado")
async def list_all_providers() -> Dict[str, Any]:
    """Devuelve la lista detallada de proveedores clasificados en proveedores de descarga y proveedores de metadatos."""
    installed = extension_manager.list_installed()
    installed_map = {ext.name: ext for ext in installed}

    download_providers = []
    metadata_providers = []

    # Process providers configuration
    config_data = await get_providers_capabilities()
    for prov in config_data.get("providers", []):
        prov_id = prov.get("id")
        ext = installed_map.get(prov_id)
        
        info = {
            "id": prov_id,
            "display_name": prov.get("display_name"),
            "is_download_provider": prov.get("is_download_provider", True),
            "is_metadata_provider": prov.get("is_metadata_provider", True),
            "capabilities": prov.get("capabilities", []),
            "qualities": prov.get("qualities", []),
            "version": ext.version if ext else "1.0.0",
            "type": "extension" if ext else "native",
            "status": "active",
        }

        if prov.get("is_download_provider"):
            download_providers.append(info)
        else:
            metadata_providers.append(info)

    return {
        "total_download_providers": len(download_providers),
        "total_metadata_providers": len(metadata_providers),
        "download_providers": download_providers,
        "metadata_providers": metadata_providers,
    }


@app.get("/api/v1/health", tags=["Providers & Capabilities"], summary="Diagnóstico de salud de los endpoints nativos")
async def get_health() -> Dict[str, Any]:
    """Prueba la accesibilidad de los servidores de audio (Tidal, Qobuz, Amazon, Deezer) y responde con su estado en vivo."""
    try:
        results = await run_health_check(["tidal", "qobuz", "amazon", "deezer"])
        status_dict = {}
        for res in results:
            prov = getattr(res, "provider", "unknown")
            ok = getattr(res, "ok", False)
            status_dict[prov] = "OK" if ok else "UNREACHABLE"
        return {
            "status": "online",
            "download_dir": task_manager.default_output_dir,
            "services_health": status_dict,
        }
    except Exception as exc:
        return {"status": "online", "services_health_error": str(exc)}


# ─── Search & Metadata Endpoints ──────────────────────────────

@app.get("/api/v1/search/autocomplete", tags=["Search & Metadata"], summary="Búsqueda rápida en tiempo real para autocompletado")
@app.get("/api/v1/search", tags=["Search & Metadata"], summary="Buscar canciones por texto")
async def search_tracks(
    q: str = Query(..., min_length=2, description="Texto de búsqueda (título, artista o álbum)"),
    explicit: Optional[bool] = Query(None, description="Filtrar o solicitar versión explícita")
) -> List[Dict[str, Any]]:
    """Realiza una búsqueda combinada en Spotify e iTunes/Apple Music para sugerir canciones en tiempo real."""
    results = []

    # 1. Spotify search
    try:
        async with AsyncSpotiFLAC(output_dir=TEMP_DOWNLOAD_DIR) as client:
            search_res = await client.search(q, limit=6)
            if search_res and "tracks" in search_res:
                for item in search_res["tracks"]:
                    results.append({
                        "title": item.get("name") or item.get("title", ""),
                        "artist": item.get("artist") or item.get("artists", ""),
                        "album": item.get("album", ""),
                        "cover_url": item.get("cover_url", ""),
                        "url": item.get("external_url") or f"https://open.spotify.com/track/{item.get('id')}",
                        "explicit": bool(item.get("explicit") or item.get("is_explicit")),
                        "duration_ms": item.get("duration_ms", 180000),
                        "source": "spotify",
                    })
    except Exception:
        pass

    # 2. iTunes Search API fallback (with explicit=Yes to fetch explicit tracks)
    if len(results) < 5:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    "https://itunes.apple.com/search",
                    params={"term": q, "entity": "song", "limit": 10, "explicit": "Yes", "country": "US"},
                )
                if res.status_code == 200:
                    data = res.json()
                    for item in data.get("results", []):
                        track_url = item.get("trackViewUrl") or ""
                        cover = item.get("artworkUrl100", "").replace("100x100bb", "3000x3000bb")
                        is_exp = (
                            item.get("trackExplicitness") == "explicit"
                            or item.get("collectionExplicitness") == "explicit"
                            or item.get("contentAdvisoryRating") == "Explicit"
                        )
                        results.append({
                            "title": item.get("trackName", ""),
                            "artist": item.get("artistName", ""),
                            "album": item.get("collectionName", ""),
                            "cover_url": cover,
                            "url": track_url,
                            "explicit": is_exp,
                            "duration_ms": item.get("trackTimeMillis", 180000),
                            "source": "apple",
                        })
        except Exception:
            pass

    return results[:10]


async def _enrich_track_dict(tr: Dict[str, Any]) -> Dict[str, Any]:
    title = tr.get("title", "")
    artist = tr.get("artist", "")
    album = tr.get("album", "")
    isrc = tr.get("isrc", "")

    if not title or not artist:
        return tr

    try:
        from SpotiFLAC.core.metadata_enrichment import _AppleMusicMeta
        am = _AppleMusicMeta()
        enriched = await am.fetch_async(title, artist, isrc=isrc)

        orig_artist = tr.get("artist", "").lower().strip()
        enr_artist = (enriched.artist or "").lower().strip()
        if enriched.title and enriched.artist and (not orig_artist or orig_artist in enr_artist or enr_artist in orig_artist):
            tr["title"] = enriched.title
            tr["artist"] = enriched.artist
        tr["album_artist"] = enriched.album_artist or tr.get("artist", "")
        if enriched.album and enriched.album != "YouTube":
            tr["album"] = enriched.album
        if enriched.date:
            tr["release_date"] = enriched.date
        if enriched.year:
            tr["year"] = enriched.year
        if enriched.track_number:
            tr["track_number"] = enriched.track_number
        if enriched.track_total:
            tr["track_total"] = enriched.track_total
        if enriched.disc_number:
            tr["disc_number"] = enriched.disc_number
        if enriched.disc_total:
            tr["disc_total"] = enriched.disc_total
        if enriched.genre:
            tr["genre"] = enriched.genre
        if enriched.label:
            tr["label"] = enriched.label
        if enriched.copyright:
            tr["copyright"] = enriched.copyright
        if enriched.explicit:
            tr["explicit"] = True
        if enriched.isrc and not tr.get("isrc"):
            tr["isrc"] = enriched.isrc
        if enriched.cover_url_hd:
            tr["cover_url"] = enriched.cover_url_hd

        anim_data = await fetch_animated_artwork(tr["artist"], tr["album"], tr["title"])
        if anim_data and isinstance(anim_data, dict):
            tr["animated_cover_url"] = anim_data.get("animated_url") or anim_data.get("url")
    except Exception as exc:
        logger.debug("[api/metadata] enrichment fallback: %s", exc)

    return tr


@app.get("/api/v1/metadata", tags=["Search & Metadata"], summary="Resolver metadatos completos de cualquier enlace o búsqueda")
async def get_metadata(url: str = Query(..., description="URL de cualquier plataforma o texto de búsqueda")) -> Dict[str, Any]:
    """Inspecciona y devuelve los metadatos completos enriquecidos por Apple Music (título, artista, álbum, fecha, género, sello, copyright, pista, disco, portadas 3000x) para cualquier URL o texto."""
    target_url = url.strip()
    fallback_item = None

    if not target_url.startswith(("http://", "https://", "spotify:")):
        search_res = await search_tracks(q=target_url)
        if not search_res:
            raise HTTPException(status_code=404, detail=f"No se encontraron resultados para: {target_url}")
        fallback_item = search_res[0]
        target_url = fallback_item["url"]

    try:
        async with AsyncSpotiFLAC(output_dir=TEMP_DOWNLOAD_DIR) as client:
            info, tracks = await client.get_playlist(target_url)
            tracks_list = [
                {
                    "title": t.title,
                    "artist": getattr(t, "artists", getattr(t, "artist", "")),
                    "album": t.album,
                    "isrc": t.isrc,
                    "duration_ms": t.duration_ms,
                    "explicit": getattr(t, "is_explicit", getattr(t, "explicit", False)),
                    "cover_url": t.cover_url,
                }
                for t in tracks
            ]
            # Enrich all tracks with Apple Music / iTunes complete metadata
            enriched_tracks = await asyncio.gather(*[_enrich_track_dict(tr) for tr in tracks_list])

            # Update collection_info if single track
            if len(enriched_tracks) == 1:
                first_tr = enriched_tracks[0]
                info["name"] = first_tr.get("title", info.get("name"))
                info["artist"] = first_tr.get("artist", "")
                info["album"] = first_tr.get("album", "")

            return {
                "collection_info": info,
                "total_tracks": len(enriched_tracks),
                "resolved_url": target_url,
                "tracks": enriched_tracks,
            }
    except Exception as exc:
        if fallback_item:
            raw_tr = {
                "title": fallback_item["title"],
                "artist": fallback_item["artist"],
                "album": fallback_item["album"],
                "isrc": "",
                "duration_ms": fallback_item.get("duration_ms", 180000),
                "explicit": fallback_item.get("explicit", False),
                "cover_url": fallback_item.get("cover_url", ""),
            }
            enriched_tr = await _enrich_track_dict(raw_tr)
            return {
                "collection_info": {"name": enriched_tr["title"], "type": "track", "artist": enriched_tr["artist"], "album": enriched_tr["album"]},
                "total_tracks": 1,
                "resolved_url": fallback_item["url"],
                "tracks": [enriched_tr],
            }
        raise HTTPException(status_code=400, detail=f"Error resolviendo metadatos: {exc}")


@app.get("/api/v1/artwork/info", tags=["Search & Metadata"], summary="Obtener portada animada (.m3u8) y 3000x HD de Apple Music")
async def get_artwork_info(
    artist: Optional[str] = Query("", description="Nombre del artista"),
    title: Optional[str] = Query("", description="Título de la canción"),
    album: Optional[str] = Query("", description="Nombre del álbum"),
    url: Optional[str] = Query("", description="URL directa de la canción o álbum de Apple Music")
) -> Dict[str, Any]:
    """Obtiene la URL del video animado (.m3u8) de Apple Music (por URL o por artista/título) y la portada HD 3000x3000px."""
    artist_str = str(artist) if artist and not hasattr(artist, "default") else ""
    title_str = str(title) if title and not hasattr(title, "default") else ""
    album_str = str(album) if album and not hasattr(album, "default") else ""
    url_str = str(url) if url and not hasattr(url, "default") else ""

    anim_data = await fetch_animated_artwork(artist=artist_str, album=album_str, title=title_str, apple_url=url_str)
    animated_url = None
    if anim_data and isinstance(anim_data, dict):
        animated_url = anim_data.get("animated_url") or anim_data.get("url")

    hd_cover_url = await fetch_itunes_3000x_cover_url(artist_str, title_str, album_str)

    return {
        "artist": artist_str,
        "title": title_str,
        "album": album_str,
        "url": url_str,
        "animated_url": animated_url,
        "hd_cover_url": hd_cover_url,
        "has_animated": bool(animated_url),
    }


@app.get("/api/v1/lyrics", tags=["Search & Metadata"], summary="Obtener letras sincronizadas (LRC) o texto plano")
async def get_lyrics(
    artist: Optional[str] = Query(None),
    title: Optional[str] = Query(None),
    url: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Busca y devuelve las letras sincronizadas en formato LRC para cualquier canción."""
    search_artist = artist
    search_title = title

    if url and (not search_artist or not search_title):
        try:
            meta = await get_metadata(url=url)
            if meta.get("tracks"):
                search_artist = meta["tracks"][0]["artist"]
                search_title = meta["tracks"][0]["title"]
        except Exception:
            pass

    if not search_artist or not search_title:
        raise HTTPException(status_code=400, detail="Especifica 'artist' y 'title', o proporciona un 'url'")

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(
                "https://lrclib.net/api/get",
                params={"artist_name": search_artist, "track_name": search_title},
            )
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "artist": search_artist,
                    "title": search_title,
                    "synced_lyrics": data.get("syncedLyrics"),
                    "plain_lyrics": data.get("plainLyrics"),
                    "found": True,
                }
    except Exception as exc:
        logger.debug("Lyrics fetch error: %s", exc)

    return {
        "artist": search_artist,
        "title": search_title,
        "synced_lyrics": None,
        "plain_lyrics": None,
        "found": False,
    }


# ─── Downloads & Tasks Endpoints ──────────────────────────────

@app.post("/api/v1/downloads", tags=["Downloads & Tasks"], summary="Iniciar una tarea de descarga en segundo plano")
async def start_download(req: DownloadRequest) -> Dict[str, Any]:
    """Crea e inicia una tarea asíncrona de descarga de audio Lossless en el servidor."""
    task = task_manager.create_task(
        url=req.url,
        output_dir=req.output_dir,
        services=req.services,
        quality=req.quality,
        embed_lyrics=req.embed_lyrics,
        enrich_metadata=req.enrich_metadata,
        filename_format=req.filename_format,
    )
    return {"message": "Tarea de descarga creada", "task": task.to_dict()}


@app.get("/api/v1/tasks", tags=["Downloads & Tasks"], summary="Listar tareas de descarga recientes")
async def list_tasks(limit: int = Query(50, ge=1, le=100)) -> List[Dict[str, Any]]:
    """Devuelve la lista de tareas de descarga activas e históricas."""
    return task_manager.list_tasks(limit=limit)


@app.get("/api/v1/tasks/{task_id}", tags=["Downloads & Tasks"], summary="Obtener estado detallado de una tarea")
async def get_task_status(task_id: str) -> Dict[str, Any]:
    """Devuelve el progreso porcentual, estado y logs de una tarea específica."""
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Tarea no encontrada")
    return task.to_dict()


@app.post("/api/v1/tasks/{task_id}/cancel", tags=["Downloads & Tasks"], summary="Cancelar una tarea en ejecución")
async def cancel_task(task_id: str) -> Dict[str, Any]:
    """Cancela una tarea activa en segundo plano."""
    success = task_manager.cancel_task(task_id)
    if not success:
        raise HTTPException(status_code=400, detail="No se pudo cancelar la tarea (inválida o ya finalizada)")
    return {"message": "Tarea cancelada con éxito", "task_id": task_id}


@app.websocket("/api/v1/tasks/{task_id}/ws")
async def task_websocket(websocket: WebSocket, task_id: str):
    """Canal WebSocket para recibir actualizaciones y logs de descarga en tiempo real."""
    task = task_manager.get_task(task_id)
    if not task:
        await websocket.close(code=4004, reason="Task not found")
        return

    await websocket.accept()
    await websocket.send_text(json.dumps(task.to_dict()))

    async def listener(data: Dict[str, Any]):
        try:
            await websocket.send_text(json.dumps(data))
        except Exception:
            pass

    task_manager.register_listener(task_id, listener)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        task_manager.unregister_listener(task_id, listener)


@app.get("/api/v1/files/{task_id}", tags=["Downloads & Tasks"], summary="Descargar archivos FLAC / ZIP resultantes")
async def download_task_files(task_id: str):
    """Entrega directamente el archivo audio FLAC generado o un archivo comprimido .zip si fue un álbum/playlist."""
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Tarea no encontrada")

    if Path(task.output_dir).exists():
        found_audio = [
            str(p) for p in Path(task.output_dir).glob("**/*")
            if p.is_file() and p.suffix.lower() in (".flac", ".mp3", ".m4a")
        ]
        if found_audio:
            task.downloaded_files = found_audio

    if not task.downloaded_files:
        raise HTTPException(status_code=400, detail="La tarea no ha completado o no generó archivos")

    audio_files = [f for f in task.downloaded_files if Path(f).suffix.lower() in (".flac", ".mp3", ".m4a")]
    files_to_serve = audio_files if audio_files else task.downloaded_files

    if len(files_to_serve) == 1:
        filepath = Path(files_to_serve[0])
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Archivo no encontrado en disco")
        ext = filepath.suffix.lower()
        media_type = "audio/flac" if ext == ".flac" else ("audio/mpeg" if ext == ".mp3" else "application/octet-stream")
        return FileResponse(path=filepath, filename=filepath.name, media_type=media_type)

    zip_path = Path(task.output_dir) / f"spotiflac_{task_id[:8]}.zip"
    if not zip_path.exists():
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fpath in files_to_serve:
                p = Path(fpath)
                if p.exists():
                    zf.write(p, arcname=p.name)

    return FileResponse(path=zip_path, filename=zip_path.name, media_type="application/zip")


# ─── Extensions System Endpoints ──────────────────────────────

@app.get("/api/v1/extensions/registry", tags=["Extensions System"], summary="Obtener catálogo de extensiones remotas")
async def get_extension_registry() -> Dict[str, Any]:
    """Obtiene la lista oficial de extensiones disponibles en el repositorio GitHub."""
    try:
        from SpotiFLAC.extensions.manager import REGISTRY_URL
        entries = await asyncio.to_thread(extension_manager.fetch_registry)
        return {
            "registry_url": REGISTRY_URL,
            "total_extensions": len(entries),
            "extensions": [
                {
                    "id": e.id,
                    "display_name": e.display_name,
                    "version": e.version,
                    "description": e.description,
                    "download_url": e.download_url,
                    "category": e.category,
                    "tags": e.tags,
                    "icon_url": e.icon_url,
                }
                for e in entries
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error consultando registry: {exc}")


@app.get("/api/v1/extensions/installed", tags=["Extensions System"], summary="Listar extensiones instaladas localmente")
async def get_installed_extensions() -> List[Dict[str, Any]]:
    """Devuelve todas las extensiones JS instaladas en la instancia actual."""
    try:
        installed = extension_manager.list_installed()
        return [
            {
                "name": ext.name,
                "display_name": ext.display_name,
                "version": ext.version,
                "description": ext.description,
                "ext_dir": str(ext.ext_dir),
                "is_download_provider": ext.is_download_provider,
                "is_metadata_provider": ext.is_metadata_provider,
                "url_patterns": ext.url_patterns,
                "quality_options": ext.manifest.get("qualityOptions", []),
            }
            for ext in installed
        ]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error leyendo extensiones: {exc}")


@app.post("/api/v1/extensions/sync", tags=["Extensions System"], summary="Sincronizar y actualizar extensiones del registro oficial")
async def sync_all_extensions() -> Dict[str, Any]:
    """Descarga e instala todas las extensiones del registro remoto oficial."""
    try:
        await asyncio.to_thread(extension_manager.ensure_download_providers, force_update=True)
        updated = extension_manager.list_installed()
        return {
            "message": "Extensiones sincronizadas y actualizadas correctamente con el registro oficial",
            "total_installed": len(updated),
            "installed": [e.name for e in updated],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error sincronizando extensiones: {exc}")


@app.post("/api/v1/extensions/install", tags=["Extensions System"], summary="Instalar extensión por URL o ID")
async def install_extension(req: InstallExtensionRequest) -> Dict[str, Any]:
    """Instala una extensión desde el registro o desde una URL `.sflx` personalizada."""
    try:
        url_or_id = req.download_url_or_id
        if not url_or_id.startswith("http"):
            entries = await asyncio.to_thread(extension_manager.fetch_registry)
            matched = next((e for e in entries if e.id == url_or_id), None)
            if not matched:
                raise HTTPException(status_code=404, detail=f"Extensión ID '{url_or_id}' no encontrada en el registro")
            download_url = matched.download_url
        else:
            download_url = url_or_id

        installed_ext = await asyncio.to_thread(extension_manager.install_from_url, download_url)
        return {
            "message": f"Extensión '{installed_ext.display_name}' instalada con éxito",
            "extension": {
                "name": installed_ext.name,
                "display_name": installed_ext.display_name,
                "version": installed_ext.version,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error instalando extensión: {exc}")


@app.get("/api/v1/extensions/{ext_id}/settings", tags=["Extensions System"], summary="Obtener configuración de una extensión")
async def get_extension_settings(ext_id: str) -> Dict[str, Any]:
    """Devuelve las opciones configurables y los valores actuales de la extensión."""
    ext = extension_manager.get_installed(ext_id)
    if not ext:
        raise HTTPException(status_code=404, detail=f"Extensión '{ext_id}' no está instalada")

    schema = ext.settings_schema
    current = extension_manager.load_settings(ext_id)
    return {
        "ext_id": ext_id,
        "display_name": ext.display_name,
        "settings_schema": schema,
        "current_values": current,
    }


@app.put("/api/v1/extensions/{ext_id}/settings", tags=["Extensions System"], summary="Guardar valores de configuración de una extensión")
async def save_extension_settings(ext_id: str, req: SaveSettingsRequest) -> Dict[str, Any]:
    """Guarda nuevos parámetros de configuración para la extensión especificada."""
    ext = extension_manager.get_installed(ext_id)
    if not ext:
        raise HTTPException(status_code=404, detail=f"Extensión '{ext_id}' no está instalada")

    try:
        existing = extension_manager.load_settings(ext_id)
        existing.update(req.settings)
        extension_manager.save_settings(ext_id, existing)
        return {
            "message": f"Configuración de '{ext_id}' guardada con éxito",
            "saved_values": existing,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error guardando configuración: {exc}")


@app.post("/api/v1/extensions/{ext_id}/reset-settings", tags=["Extensions System"], summary="Resetear valores de configuración por defecto")
async def reset_extension_settings(ext_id: str) -> Dict[str, Any]:
    """Restaura los parámetros de la extensión a sus valores por defecto de fábrica."""
    from SpotiFLAC.extensions.manager import _EXTENSION_KNOWN_DEFAULTS
    ext = extension_manager.get_installed(ext_id)
    if not ext:
        raise HTTPException(status_code=404, detail=f"Extensión '{ext_id}' no está instalada")

    defaults = ext.default_settings()
    known = _EXTENSION_KNOWN_DEFAULTS.get(ext_id, {})
    defaults.update(known)
    extension_manager.save_settings(ext_id, defaults)
    return {
        "message": f"Configuración de '{ext_id}' reseteada a valores por defecto",
        "default_values": defaults,
    }


@app.delete("/api/v1/extensions/{name}", tags=["Extensions System"], summary="Desinstalar extensión por nombre")
async def uninstall_extension(name: str) -> Dict[str, Any]:
    """Elimina una extensión instalada del almacenamiento local."""
    try:
        success = extension_manager.uninstall(name)
        if not success:
            raise HTTPException(status_code=404, detail=f"La extensión '{name}' no existe o no se pudo desinstalar")
        return {"message": f"Extensión '{name}' eliminada con éxito"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error desinstalando extensión: {exc}")


# ─── Sessions & Verification Endpoints ────────────────────────

@app.get("/api/v1/sessions/grant_callback", tags=["Sessions & Verification"], summary="Callback GET para recepción automática de Turnstile")
async def grant_callback_get(request: Request, grant: str = "", state: str = ""):
    """Endpoint de retorno invocado por la ventana popup de Cloudflare Turnstile tras completar el captcha."""
    if not grant:
        return HTMLResponse("<h1>Falta el parámetro grant</h1>", status_code=400)

    if state in web_ui_solver.pending_grants:
        fut = web_ui_solver.pending_grants.pop(state)
        if not fut.done():
            fut.set_result(grant)

    html = f"""<!DOCTYPE html>
<html>
<head>
<script>
    window.parent.postMessage({{type: 'cloudflare_success', grant: '{grant}', state: '{state}'}}, '*');
</script>
</head>
<body style="background: #1c1c1e; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: -apple-system, sans-serif; margin: 0;">
    <h1 style="margin: 0; font-size: 24px; display: flex; align-items: center; gap: 10px;">
        <span style="background: #34c759; color: black; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px;">✓</span> 
        Verificación Completada
    </h1>
    <p style="color: #999; margin-top: 10px;">Continuando descarga...</p>
</body>
</html>
"""
    return HTMLResponse(content=html)


@app.post("/api/v1/sessions/grant", tags=["Sessions & Verification"], summary="Intercambiar token de grant para verificar la sesión Zarz")
async def exchange_session_grant(req: SessionGrantRequest) -> Dict[str, Any]:
    """Puntos de entrada para inyectar manualmente o automáticamente un token 'grant' a la sesión de descargas."""
    try:
        if req.namespace in web_ui_solver.pending_grants:
            fut = web_ui_solver.pending_grants.pop(req.namespace)
            if not fut.done():
                fut.set_result(req.grant)
                return {"message": "Sesión reanudada en background", "authenticated": True}

        from SpotiFLAC.core.signed_session_mobile import SignedSessionClient
        client = SignedSessionClient(
            base_url="https://api.zarz.moe/v2",
            namespace=req.namespace,
        )
        await client.exchange_grant(req.grant)
        return {
            "message": "Sesión verificada y guardada correctamente",
            "authenticated": client.authenticated,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Error intercambiando grant: {exc}")


# ─── System & Diagnostics Endpoint ───────────────────────────

@app.get("/api/v1/system/info", tags=["Providers & Capabilities"], summary="Estadísticas de rendimiento del servidor")
async def get_system_info() -> Dict[str, Any]:
    """Proporciona información del sistema, versión de Python, tiempo de actividad y uso de disco."""
    uptime_seconds = int(time.time() - SERVER_START_TIME)

    temp_size_bytes = 0
    if os.path.exists(TEMP_DOWNLOAD_DIR):
        for root, dirs, files in os.walk(TEMP_DOWNLOAD_DIR):
            for f in files:
                try:
                    temp_size_bytes += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass

    return {
        "server": "SpotiFLAC Extended Engine",
        "version": "1.6.0",
        "python_version": sys.version.split()[0],
        "uptime_seconds": uptime_seconds,
        "active_tasks": len([t for t in task_manager._tasks.values() if t.status == "running"]),
        "total_tasks_processed": len(task_manager._tasks),
        "installed_extensions_count": len(extension_manager.list_installed()),
        "temp_storage_mb": round(temp_size_bytes / (1024 * 1024), 2),
    }
