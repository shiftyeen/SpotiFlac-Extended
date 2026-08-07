"""extensions/manager.py — ExtensionManager.

Manages the lifecycle of locally installed extensions:
  - Fetch of remote registry
  - Installation / update from URL
  - Removal
  - Listing
  - Auto-setup of download providers on startup

Default directory: ~/.spotiflac/extensions/{name}/
  ├── index.js
  ├── manifest.json
  └── icon.jpg          (optional)
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

REGISTRY_URL = (
    "https://raw.githubusercontent.com/spotiflacapp/spotiflac-extension/main/registry.json"
)
FALLBACK_REGISTRY_URL = (
    "https://raw.githubusercontent.com/zarzet/SpotiFLAC-Extension/main/registry.json"
)


DEFAULT_EXT_DIR = Path.home() / ".spotiflac" / "extensions"
# Known default settings that mirror the SpotiFLAC Mobile app's extension Settings pages.
_EXTENSION_KNOWN_DEFAULTS: dict[str, dict] = {
    "tidal-web": {
        "publicToken": "49YxDN9a2aFV6RTG",
        "countryCode": "US",
        "locale": "en_US",
        "deviceType": "BROWSER",
        "downloadApiUrl": "https://api.zarz.moe/v1/dl/tid2",
    },
    "amazon": {
        "countryCode": "US",
        "locale": "en_US",
    },
    "deezer": {
        "countryCode": "US",
    },
}


# ─────────────────────────────────────────────────────────────
#  Models
# ─────────────────────────────────────────────────────────────


@dataclass
class RegistryEntry:
    id: str
    display_name: str
    version: str
    description: str
    download_url: str
    category: str = "unknown"
    tags: list[str] = field(default_factory=list)
    min_app_version: str = "0.0.0"
    icon_url: str | None = None
    updated_at: str = ""


@dataclass
class InstalledExtension:
    name: str
    display_name: str
    version: str
    description: str
    ext_dir: Path
    manifest: dict = field(default_factory=dict)

    @property
    def index_js(self) -> Path:
        return self.ext_dir / "index.js"

    @property
    def types(self) -> list[str]:
        return self.manifest.get("type", [])

    @property
    def is_download_provider(self) -> bool:
        return "download_provider" in self.types

    @property
    def is_metadata_provider(self) -> bool:
        return "metadata_provider" in self.types

    @property
    def url_patterns(self) -> list[str]:
        return self.manifest.get("urlHandler", {}).get("patterns", [])

    @property
    def settings_schema(self) -> list[dict]:
        return self.manifest.get("settings", [])

    def default_settings(self) -> dict:
        return {
            s["key"]: s.get("default", "") for s in self.settings_schema if "key" in s
        }


BUILTIN_EXT_DIR = Path(__file__).parent.parent / "extensions_builtin"


def sync_builtin_extensions(target_dir: Path) -> None:
    """Syncs bundled repository extensions from extensions_builtin into target_dir."""
    if not BUILTIN_EXT_DIR.exists():
        return
    import shutil
    target_dir.mkdir(parents=True, exist_ok=True)
    for child in BUILTIN_EXT_DIR.iterdir():
        if child.is_dir():
            dest = target_dir / child.name
            if not dest.exists():
                try:
                    shutil.copytree(child, dest, dirs_exist_ok=True)
                    logger.info("[ExtMgr] Seeded bundled extension '%s' to %s", child.name, dest)
                except Exception as exc:
                    logger.warning("[ExtMgr] Failed to seed bundled extension '%s': %s", child.name, exc)


# ─────────────────────────────────────────────────────────────
#  ExtensionManager
# ─────────────────────────────────────────────────────────────


class ExtensionManager:
    """Central point for managing SpotiFLAC JS extensions."""

    def __init__(
        self,
        ext_dir: str | Path | None = None,
        timeout: float = 20.0,
        auto_install_downloads: bool = True,
    ) -> None:
        self.ext_dir = Path(ext_dir) if ext_dir else DEFAULT_EXT_DIR
        self.timeout = timeout
        self.ext_dir.mkdir(parents=True, exist_ok=True)

        # Seed bundled repository extensions into ext_dir
        sync_builtin_extensions(self.ext_dir)

        if auto_install_downloads:
            self.ensure_download_providers()

    # ── Auto Setup ───────────────────────────────────────────

    def ensure_download_providers(
        self,
        registry_url: str = REGISTRY_URL,
        force_update: bool = False,
    ) -> None:
        """Checks the remote registry and automatically installs (or updates)
        all extensions classified as download providers.

        Parameters
        ----------
        force_update : bool
            When True, always re-download and re-install every extension even
            if the locally installed version number matches the registry.
            This is useful for picking up JS code changes that were shipped
            without a version bump, or to ensure the extension is in sync
            with a changed remote backend configuration.
        """
        logger.info("[ExtMgr] Automatic check for download extensions on startup...")
        try:
            entries = self.fetch_registry(registry_url)
        except Exception as e:
            logger.warning("[ExtMgr] Unable to retrieve registry for auto-setup: %s", e)
            return

        for entry in entries:
            # Identifies if the extension is a download provider via category or tag
            is_download = (
                entry.category in ("download", "download_provider")
                or "download" in entry.tags
                or "download_provider" in entry.tags
            )

            if not is_download:
                continue

            existing = self.get_installed(entry.id)

            # If already installed and version matches, skip without downloading
            # — unless force_update is requested.
            if existing and existing.version == entry.version and not force_update:
                logger.debug(
                    "[ExtMgr] '%s' is already installed and updated (v%s)",
                    entry.id,
                    entry.version,
                )
                continue

            # Otherwise, installs or updates
            if force_update and existing and existing.version == entry.version:
                action = "Force-refresh"
            else:
                action = "Update" if existing else "Installation"
            logger.info(
                "[ExtMgr] %s of '%s' to version %s...",
                action,
                entry.id,
                entry.version,
            )
            try:
                self.install_from_url(entry.download_url)
            except Exception as e:
                logger.exception(
                    "[ExtMgr] Error during %s of '%s': %s",
                    action.lower(),
                    entry.id,
                    e,
                )

    # ── Remote Registry ──────────────────────────────────────

    def fetch_registry(self, url: str = REGISTRY_URL) -> list[RegistryEntry]:
        """Downloads and parses the remote registry.json."""
        logger.debug("[ExtMgr] Fetching registry from %s", url)
        data = None
        try:
            r = httpx.get(url, timeout=self.timeout, follow_redirects=True)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            if url == REGISTRY_URL:
                logger.warning("[ExtMgr] Primary registry failed (%s), attempting fallback registry...", e)
                try:
                    r = httpx.get(FALLBACK_REGISTRY_URL, timeout=self.timeout, follow_redirects=True)
                    r.raise_for_status()
                    data = r.json()
                except Exception as fb_err:
                    msg = f"Failed to download primary and fallback registry: {fb_err}"
                    raise RuntimeError(msg) from fb_err
            else:
                msg = f"Failed to download registry: {e}"
                raise RuntimeError(msg) from e

        entries = []
        for item in data.get("extensions", []):

            entries.append(
                RegistryEntry(
                    id=item["id"],
                    display_name=item.get("display_name", item["id"]),
                    version=item.get("version", "0.0.0"),
                    description=item.get("description", ""),
                    download_url=item["download_url"],
                    category=item.get("category", "unknown"),
                    tags=item.get("tags", []),
                    min_app_version=item.get("min_app_version", "0.0.0"),
                    icon_url=item.get("icon_url"),
                    updated_at=item.get("updated_at", ""),
                ),
            )
        return entries

    # ── Installation ────────────────────────────────────────

    def install(
        self,
        ext_id: str,
        registry_url: str = REGISTRY_URL,
        settings: dict | None = None,
    ) -> InstalledExtension:
        """Installs an extension by ID from the official registry.
        If already installed, updates only if the remote version is newer.
        """
        entries = self.fetch_registry(registry_url)
        entry = next((e for e in entries if e.id == ext_id), None)
        if entry is None:
            available = ", ".join(e.id for e in entries)
            msg = f"Extension '{ext_id}' not found in registry. Available: {available}"
            raise ValueError(
                msg,
            )

        # Check if already installed and up-to-date
        existing = self.get_installed(ext_id)
        if existing and existing.version == entry.version:
            logger.info("[ExtMgr] '%s' already up-to-date (v%s)", ext_id, entry.version)
            return existing

        return self.install_from_url(entry.download_url, settings=settings)

    def install_from_url(
        self,
        url: str,
        settings: dict | None = None,
    ) -> InstalledExtension:
        """Downloads a .spotiflac-ext file (ZIP) from `url` and installs it.
        The extension name is read from `manifest.json` inside the ZIP.
        """
        logger.debug("[ExtMgr] Downloading extension from %s", url)
        try:
            r = httpx.get(url, timeout=self.timeout * 3, follow_redirects=True)
            r.raise_for_status()
            raw = r.content
        except Exception as e:
            msg = f"Error downloading extension: {e}"
            raise RuntimeError(msg) from e

        return self._install_from_bytes(raw, settings=settings)

    def install_from_file(
        self,
        path: str | Path,
        settings: dict | None = None,
    ) -> InstalledExtension:
        """Installs from a local .spotiflac-ext file (ZIP)."""
        raw = Path(path).read_bytes()
        return self._install_from_bytes(raw, settings=settings)

    def _install_from_bytes(
        self,
        raw: bytes,
        settings: dict | None = None,
    ) -> InstalledExtension:
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile as e:
            msg = f"File is not a valid .spotiflac-ext (ZIP): {e}"
            raise ValueError(msg) from e

        names = zf.namelist()
        if "manifest.json" not in names or "index.js" not in names:
            msg = (
                f"The .spotiflac-ext must contain manifest.json and index.js. "
                f"Found: {names}"
            )
            raise ValueError(
                msg,
            )

        manifest = json.loads(zf.read("manifest.json"))
        ext_name = manifest.get("name")
        if not ext_name:
            msg = "manifest.json must have the 'name' field."
            raise ValueError(msg)

        target = self.ext_dir / ext_name
        target.mkdir(parents=True, exist_ok=True)

        # Extract all files
        for member in names:
            data = zf.read(member)
            (target / member).write_bytes(data)

        # Save custom settings if provided
        if settings:
            (target / "settings.json").write_text(
                json.dumps(settings, indent=2),
                encoding="utf-8",
            )

        logger.info(
            "[ExtMgr] Success: '%s' v%s installed.",
            ext_name,
            manifest.get("version"),
        )
        loaded = self._load_installed(target)

        # Settings merge strategy (mirrors mobile app update behavior):
        #  - First install → seed with manifest defaults + known mobile-app defaults
        #  - On update → merge only NEW keys from manifest + known defaults into existing
        #    settings WITHOUT overwriting any key the user has already customized.
        #  Result: user changes survive updates; new settings keys from new extension
        #  versions are automatically picked up.
        settings_path = target / "settings.json"
        manifest_defaults = loaded.default_settings()
        known = _EXTENSION_KNOWN_DEFAULTS.get(ext_name, {})
        # Full new-version defaults (manifest + known overrides)
        new_defaults = {**manifest_defaults, **known}

        if not settings_path.exists():
            # First install: write full defaults
            if new_defaults:
                try:
                    settings_path.write_text(
                        json.dumps(new_defaults, indent=2), encoding="utf-8"
                    )
                    logger.info(
                        "[ExtMgr] Pre-seeded default settings for '%s'", ext_name
                    )
                except Exception as e:
                    logger.warning("[ExtMgr] Could not seed settings for '%s': %s", ext_name, e)
        else:
            # Update: merge only missing/new keys into existing saved settings
            try:
                existing = json.loads(settings_path.read_text(encoding="utf-8"))
                added_keys = {k: v for k, v in new_defaults.items() if k not in existing}
                if added_keys:
                    existing.update(added_keys)
                    settings_path.write_text(
                        json.dumps(existing, indent=2), encoding="utf-8"
                    )
                    logger.info(
                        "[ExtMgr] Merged %d new setting key(s) from updated manifest for '%s': %s",
                        len(added_keys), ext_name, list(added_keys.keys())
                    )
            except Exception as e:
                logger.warning("[ExtMgr] Could not merge settings for '%s': %s", ext_name, e)

        return loaded


    # ── Removal ────────────────────────────────────────────


    def uninstall(self, ext_id: str) -> bool:
        """Removes an installed extension. Returns True if found and removed."""
        import shutil

        target = self.ext_dir / ext_id
        if target.exists():
            shutil.rmtree(target)
            logger.info("[ExtMgr] Uninstalled '%s'", ext_id)
            return True
        logger.warning("[ExtMgr] '%s' not installed", ext_id)
        return False

    # ── Listing ──────────────────────────────────────────────

    def list_installed(self) -> list[InstalledExtension]:
        """Returns all installed extensions."""
        result = []
        for d in sorted(self.ext_dir.iterdir()):
            if d.is_dir() and (d / "manifest.json").exists():
                try:
                    result.append(self._load_installed(d))
                except Exception as e:
                    logger.warning("[ExtMgr] Skip '%s': %s", d.name, e)
        return result

    def get_installed(self, ext_id: str) -> InstalledExtension | None:
        """Returns an installed extension by ID, or None if not found."""
        target = self.ext_dir / ext_id
        if target.exists() and (target / "manifest.json").exists():
            try:
                return self._load_installed(target)
            except Exception:
                return None
        return None

    def load_settings(self, ext_id: str) -> dict:
        """Loads saved settings for an extension (merge with defaults)."""
        ext = self.get_installed(ext_id)
        if not ext:
            return {}
        defaults = ext.default_settings()
        settings_path = ext.ext_dir / "settings.json"
        if settings_path.exists():
            try:
                saved = json.loads(settings_path.read_text(encoding="utf-8"))
                defaults.update(saved)
            except Exception:
                pass
        return defaults

    def save_settings(self, ext_id: str, settings: dict) -> None:
        """Saves custom settings for an extension."""
        ext = self.get_installed(ext_id)
        if not ext:
            msg = f"Extension '{ext_id}' not installed."
            raise ValueError(msg)
        (ext.ext_dir / "settings.json").write_text(
            json.dumps(settings, indent=2),
            encoding="utf-8",
        )

    # ── URL Resolution ──────────────────────────────────────

    def find_extension_for_url(self, url: str) -> InstalledExtension | None:
        """Returns the first installed extension whose urlHandler
        matches the provided URL.
        """
        url_lower = url.lower()
        for ext in self.list_installed():
            for pattern in ext.url_patterns:
                if pattern.lower() in url_lower:
                    return ext
        return None

    # ── Helpers ──────────────────────────────────────────────

    def _load_installed(self, ext_dir: Path) -> InstalledExtension:
        manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
        return InstalledExtension(
            name=manifest.get("name", ext_dir.name),
            display_name=manifest.get("displayName", ext_dir.name),
            version=manifest.get("version", "0.0.0"),
            description=manifest.get("description", ""),
            ext_dir=ext_dir,
            manifest=manifest,
        )

    # ── Batch update ──────────────────────────────────────

    def update_all(self, registry_url: str = REGISTRY_URL) -> dict[str, str]:
        """Updates all installed extensions that have a newer version
        in the registry.
        Returns dict {ext_id: 'updated'|'already_up_to_date'|'not_in_registry'}.
        """
        installed = {e.name: e for e in self.list_installed()}
        if not installed:
            return {}

        entries = {e.id: e for e in self.fetch_registry(registry_url)}
        status: dict[str, str] = {}

        for name, ext in installed.items():
            if name not in entries:
                status[name] = "not_in_registry"
                continue
            remote = entries[name]
            if remote.version != ext.version:
                try:
                    self.install_from_url(remote.download_url)
                    status[name] = f"updated → {remote.version}"
                except Exception as e:
                    status[name] = f"error: {e}"
            else:
                status[name] = "already_up_to_date"

        return status

    def force_update_all(self, registry_url: str = REGISTRY_URL) -> None:
        """Force-refresh all download extensions from the remote registry,
        re-downloading even if the local version number matches.

        Use this on server startup to ensure JS code is always in sync with
        the remote backend, even when the extension version was not bumped.
        """
        self.ensure_download_providers(registry_url=registry_url, force_update=True)
