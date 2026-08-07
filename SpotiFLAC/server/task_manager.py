"""SpotiFLAC/server/task_manager.py — Async background task manager for music downloads."""

from __future__ import annotations

import asyncio
import datetime
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

from SpotiFLAC.client import AsyncSpotiFLAC

logger = logging.getLogger("SpotiFLAC.server.task_manager")


@dataclass
class DownloadTask:
    task_id: str
    url: str
    output_dir: str
    status: str = "pending"  # pending, running, completed, failed, cancelled
    quality: str = "LOSSLESS"
    services: List[str] = field(default_factory=lambda: ["qobuz", "amazon", "tidal", "deezer", "youtube"])
    progress_percentage: float = 0.0
    current_track: Optional[str] = None
    tracks_completed: int = 0
    total_tracks: int = 0
    error: Optional[str] = None
    downloaded_files: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())
    completed_at: Optional[str] = None
    logs: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "url": self.url,
            "output_dir": self.output_dir,
            "status": self.status,
            "quality": self.quality,
            "services": self.services,
            "progress_percentage": round(self.progress_percentage, 1),
            "current_track": self.current_track,
            "tracks_completed": self.tracks_completed,
            "total_tracks": self.total_tracks,
            "error": self.error,
            "downloaded_files": self.downloaded_files,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
            "logs": self.logs[-20:],  # last 20 logs
        }


class TaskManager:
    """Manages async download tasks, progress tracking, WebSocket listeners, and 24h temp cleanup."""

    def __init__(self, default_output_dir: str) -> None:
        self.default_output_dir = default_output_dir
        self._tasks: Dict[str, DownloadTask] = {}
        self._listeners: Dict[str, Set[Callable[[Dict[str, Any]], Any]]] = {}
        self._active_async_tasks: Dict[str, asyncio.Task] = {}
        self._cleanup_task: Optional[asyncio.Task] = None

    def start_periodic_cleanup(self) -> None:
        """Start a background loop for purging temporary files older than 24 hours (86,400s)."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(3600)  # Check every hour
                self.purge_expired_files_and_tasks(max_age_seconds=86400)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Error in 24h cleanup loop: %s", e)

    def purge_expired_files_and_tasks(self, max_age_seconds: int = 86400) -> int:
        """Delete temporary download files and task entries older than max_age_seconds."""
        now = datetime.datetime.utcnow()
        purged_count = 0

        # Purge files in default output directory
        target_dir = Path(self.default_output_dir)
        if target_dir.exists():
            for item in target_dir.glob("**/*"):
                if item.is_file():
                    try:
                        mtime = datetime.datetime.utcfromtimestamp(item.stat().st_mtime)
                        if (now - mtime).total_seconds() > max_age_seconds:
                            item.unlink()
                            purged_count += 1
                            logger.info("[24h Cleanup] Removed expired temp file: %s", item.name)
                    except Exception as err:
                        logger.warning("Failed to delete temp file %s: %s", item, err)

        # Purge old tasks from memory
        to_delete = []
        for task_id, task in self._tasks.items():
            try:
                created_dt = datetime.datetime.fromisoformat(task.created_at)
                if (now - created_dt).total_seconds() > max_age_seconds:
                    to_delete.append(task_id)
            except Exception:
                pass

        for tid in to_delete:
            del self._tasks[tid]

        return purged_count

    def create_task(
        self,
        url: str,
        output_dir: Optional[str] = None,
        services: Optional[List[str]] = None,
        quality: str = "LOSSLESS",
        embed_lyrics: bool = True,
        enrich_metadata: bool = True,
        filename_format: str = "{title} - {artist}",
    ) -> DownloadTask:
        task_id = str(uuid.uuid4())
        base_out = Path(self.default_output_dir).resolve()

        if output_dir:
            resolved_out = Path(output_dir).resolve()
            if str(resolved_out).startswith(str(base_out)):
                out_dir = str(resolved_out)
            else:
                out_dir = str(base_out / f"task_{task_id[:8]}")
        else:
            out_dir = str(base_out / f"task_{task_id[:8]}")

        task = DownloadTask(
            task_id=task_id,
            url=url,
            output_dir=out_dir,
            quality=quality,
            services=services or ["ext:tidal-web", "ext:qobuz-web", "amazon", "qobuz", "deezer", "youtube"],
        )
        self._tasks[task_id] = task

        # Start execution in background if event loop is running
        try:
            loop = asyncio.get_running_loop()
            async_task = loop.create_task(
                self._run_download_task(
                    task,
                    embed_lyrics=embed_lyrics,
                    enrich_metadata=enrich_metadata,
                    filename_format=filename_format,
                )
            )
            self._active_async_tasks[task_id] = async_task
        except RuntimeError:
            pass
        return task

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        return self._tasks.get(task_id)

    def list_tasks(self, limit: int = 50) -> List[Dict[str, Any]]:
        tasks_sorted = sorted(
            self._tasks.values(), key=lambda t: t.created_at, reverse=True
        )
        return [t.to_dict() for t in tasks_sorted[:limit]]

    def cancel_task(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if not task:
            return False
        if task.status in ("completed", "failed", "cancelled"):
            return False

        task.status = "cancelled"
        task.completed_at = datetime.datetime.utcnow().isoformat()
        if task_id in self._active_async_tasks:
            self._active_async_tasks[task_id].cancel()
            del self._active_async_tasks[task_id]
        self._notify_listeners(task)
        return True

    def register_listener(
        self, task_id: str, callback: Callable[[Dict[str, Any]], Any]
    ) -> None:
        if task_id not in self._listeners:
            self._listeners[task_id] = set()
        self._listeners[task_id].add(callback)

    def unregister_listener(
        self, task_id: str, callback: Callable[[Dict[str, Any]], Any]
    ) -> None:
        if task_id in self._listeners:
            self._listeners[task_id].discard(callback)
            if not self._listeners[task_id]:
                del self._listeners[task_id]

    def _notify_listeners(self, task: DownloadTask) -> None:
        listeners = self._listeners.get(task.task_id, set())
        data = task.to_dict()
        for cb in list(listeners):
            try:
                if asyncio.iscoroutinefunction(cb):
                    asyncio.create_task(cb(data))
                else:
                    cb(data)
            except Exception as e:
                logger.warning("Error notifying task listener: %s", e)

    def add_log(self, task: DownloadTask, message: str) -> None:
        task.logs.append(message)
        logger.info("[Task %s] %s", task.task_id[:8], message)
        self._notify_listeners(task)

    async def _run_download_task(
        self,
        task: DownloadTask,
        embed_lyrics: bool,
        enrich_metadata: bool,
        filename_format: str,
    ) -> None:
        task.status = "running"
        self.add_log(task, f"Iniciando descarga desde: {task.url}")
        Path(task.output_dir).mkdir(parents=True, exist_ok=True)

        try:
            async with AsyncSpotiFLAC(
                output_dir=task.output_dir,
                services=task.services,
                quality=task.quality,
                embed_lyrics=embed_lyrics,
                enrich_metadata=enrich_metadata,
                filename_format=filename_format,
            ) as client:
                # First resolve metadata to know track count
                self.add_log(task, "Resolviendo metadatos del enlace...")
                playlist_info, tracks = await client.get_playlist(task.url)
                task.total_tracks = len(tracks)
                task.current_track = playlist_info.get("name", "Desconocido")
                self.add_log(
                    task,
                    f"Colección encontrada: {task.current_track} ({task.total_tracks} pistas)",
                )

                if task.total_tracks == 0:
                    task.status = "completed"
                    task.progress_percentage = 100.0
                    task.completed_at = datetime.datetime.utcnow().isoformat()
                    self.add_log(task, "No se encontraron pistas para descargar.")
                    return

                # Download track by track
                for idx, track_meta in enumerate(tracks, 1):
                    if task.status == "cancelled":
                        self.add_log(task, "Descarga cancelada por el usuario.")
                        return

                    artist_name = getattr(track_meta, "artists", getattr(track_meta, "first_artist", ""))
                    task.current_track = f"{track_meta.title} - {artist_name}"
                    provider_str = ", ".join(task.services) if task.services else "Auto"
                    self.add_log(
                        task,
                        f"[{idx}/{task.total_tracks}] Descargando: {task.current_track} · Proveedor: {provider_str} · Calidad: {task.quality}",
                    )

                    try:
                        await client.download_track(task.url)
                    except Exception as trk_err:
                        self.add_log(
                            task,
                            f"Error en pista '{task.current_track}': {trk_err}",
                        )

                    task.tracks_completed = idx
                    task.progress_percentage = (idx / task.total_tracks) * 100.0
                    self._notify_listeners(task)

                # Scan output directory for downloaded audio files
                out_path = Path(task.output_dir)
                downloaded_files = [
                    str(p) for p in out_path.glob("**/*")
                    if p.is_file() and p.suffix.lower() in (".flac", ".mp3", ".m4a", ".zip")
                ]
                task.downloaded_files = downloaded_files

                task.status = "completed"
                task.progress_percentage = 100.0
                task.completed_at = datetime.datetime.utcnow().isoformat()
                self.add_log(
                    task,
                    f"Descarga finalizada. {len(task.downloaded_files)} archivos guardados en {task.output_dir}",
                )

        except asyncio.CancelledError:
            task.status = "cancelled"
            task.completed_at = datetime.datetime.utcnow().isoformat()
            self.add_log(task, "Tarea cancelada.")
        except Exception as exc:
            task.status = "failed"
            task.error = str(exc)
            task.completed_at = datetime.datetime.utcnow().isoformat()
            self.add_log(task, f"Error grave en la descarga: {exc}")
        finally:
            if task.task_id in self._active_async_tasks:
                del self._active_async_tasks[task.task_id]
            self._notify_listeners(task)
