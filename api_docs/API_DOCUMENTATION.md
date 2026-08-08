# 📚 SpotiFLAC Extended — Documentación Completa de la API REST y WebSockets

Bienvenido a la documentación oficial de la API de **SpotiFLAC Extended**.
Esta API RESTful y canal WebSocket permiten buscar música, extraer metadatos enriquecidos de Spotify/Apple Music, descargar pistas en calidad **Hi-Res Lossless / FLAC 16/24-bit**, gestionar extensiones JavaScript y resolver desafíos de verificación Cloudflare Turnstile.

---

## 📍 Base URL & OpenAPI Docs
- **Local Access**: `http://localhost:8080`
- **VPS Public Access**: `http://<TU_IP_VPS>:8080` / `https://<TUNEL_CLOUDFLARE>.trycloudflare.com`
- **Interactive Swagger / OpenAPI UI**: `/docs`
- **ReDoc Interactive UI**: `/redoc`

---

## 🎵 1. Búsqueda y Metadatos (Search & Metadata)

### `GET /api/v1/search/autocomplete`
Búsqueda rápida autocompletada en vivo contra la base de datos oficial de Spotify.

- **Query Parameters**:
  - `q` (*string*, requerido): Término de búsqueda (ej. `Aitana`, `Aitana SUPERESTRELLA`).
  - `limit` (*integer*, opcional, defecto `10`): Número de resultados a retornar (1-50).

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "query": "Aitana SUPERESTRELLA",
  "results_count": 1,
  "tracks": [
    {
      "index": 0,
      "id": "0m2UVJS2dZjXtbi0tB2A0t",
      "title": "SUPERESTRELLA",
      "artist": "Aitana",
      "album": "CUARTO AZUL",
      "duration_ms": 172000,
      "explicit": false,
      "cover": "https://i.scdn.co/image/ab67616d00001e02e9c382b5b9b3221428da47c2",
      "isrc": "ES5012400001",
      "external_url": "https://open.spotify.com/track/0m2UVJS2dZjXtbi0tB2A0t"
    }
  ]
}
```

---

### `GET /api/v1/metadata`
Resuelve y enriquece metadatos completos para canciones, álbumes, listas de reproducción o artistas desde Spotify o enlaces directos.

- **Query Parameters**:
  - `url` (*string*, requerido): URL oficial de Spotify o enlace compatible (ej. `https://open.spotify.com/track/...`).

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "type": "track",
  "name": "SUPERESTRELLA",
  "artist": "Aitana",
  "album": "CUARTO AZUL",
  "release_date": "2024-05-10",
  "cover_url": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/.../3000x3000bb.jpg",
  "isrc": "ES5012400001",
  "track_number": 1,
  "total_tracks": 1,
  "tracks": [
    {
      "id": "0m2UVJS2dZjXtbi0tB2A0t",
      "title": "SUPERESTRELLA",
      "artist": "Aitana",
      "album": "CUARTO AZUL",
      "duration_ms": 172000,
      "isrc": "ES5012400001"
    }
  ]
}
```

---

### `GET /api/v1/artwork/info`
Obtiene la portada oficial en resolución Ultra-HD **3000x3000px** desde iTunes / Apple Music con validación estricta de artista.

- **Query Parameters**:
  - `artist` (*string*, requerido): Nombre del artista.
  - `title` (*string*, requerido): Título de la canción.
  - `album` (*string*, opcional): Nombre del álbum.
  - `url` (*string*, opcional): URL de portada fallback.

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "cover_url": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/.../3000x3000bb.jpg",
  "dimensions": "3000x3000",
  "source": "apple_music"
}
```

---

### `GET /api/v1/lyrics`
Obtiene letras sincronizadas en tiempo real (formato `.lrc`) o letras simples.

- **Query Parameters**:
  - `artist` (*string*, requerido): Artista.
  - `title` (*string*, requerido): Título de la canción.

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "artist": "Aitana",
  "title": "SUPERESTRELLA",
  "found": true,
  "synced_lyrics": "[00:12.34] Te vi bailar bajo las luces...",
  "plain_lyrics": "Te vi bailar bajo las luces..."
}
```

---

## 📥 2. Gestor de Descargas y Tareas (Downloads & Tasks)

### `POST /api/v1/downloads`
Crea e inicia una tarea de descarga en segundo plano.

- **Request Body (JSON)**:
```json
{
  "url": "https://open.spotify.com/track/0m2UVJS2dZjXtbi0tB2A0t",
  "output_dir": "",
  "services": ["ext:tidal-web", "ext:qobuz-web", "amazon", "qobuz", "deezer", "youtube"],
  "quality": "LOSSLESS",
  "embed_lyrics": true,
  "enrich_metadata": true,
  "filename_format": "{title} - {artist}"
}
```

- **Campos del Payload**:
  - `quality`: Calidad de audio deseada (`HI_RES_LOSSLESS`, `LOSSLESS`, `HIGH`, `LOW`, `DOLBY_ATMOS`).
  - `services`: Lista priorizada de proveedores a intentar secuencialmente.

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "message": "Tarea de descarga creada",
  "task": {
    "task_id": "5676d3da-9b35-4067-8ec9-ef9bcad1b8cb",
    "url": "https://open.spotify.com/track/0m2UVJS2dZjXtbi0tB2A0t",
    "status": "running",
    "progress_percent": 0.0,
    "quality": "LOSSLESS",
    "created_at": "2026-08-08T00:20:00.000Z"
  }
}
```

---

### `GET /api/v1/tasks/{task_id}`
Obtiene el estado detallado, porcentaje de avance, archivos generados y logs en tiempo real de una tarea.

- **Ejemplo de Respuesta (`200 OK`)**:
```json
{
  "task_id": "5676d3da-9b35-4067-8ec9-ef9bcad1b8cb",
  "status": "completed",
  "progress_percent": 100.0,
  "downloaded_files": [
    "/app/downloads/task_5676d3da/SUPERESTRELLA - Aitana.flac"
  ],
  "logs": [
    "▶ Proveedor: ext:tidal-web · Calidad Solicitada: LOSSLESS",
    "✓ [ext:qobuz-web] Calidad: LOSSLESS — Descargado: SUPERESTRELLA (Aitana)"
  ]
}
```

---

### `GET /api/v1/files/{task_id}`
Descarga directamente el archivo de audio resultantes (`.flac`, `.mp3`) o un archivo comprimido `.zip` si la descarga incluyó un álbum o playlist completa.

- **Response**: `FileResponse` con `Content-Type: audio/flac` o `application/zip`.

---

### `WS /api/v1/tasks/{task_id}/ws`
Canal WebSocket interactivo para recibir actualizaciones del progreso porcentual y logs de la consola en tiempo real.

---

## ⚙️ 3. Sistema e Información General

### `GET /api/v1/system/info`
Proporciona métricas del servidor, versión de Python, uso de almacenamiento temporal y tiempo de actividad.
