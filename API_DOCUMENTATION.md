# WaveX API v2.0 — Documentación Oficial Completa

Bienvenido a la documentación técnica exhaustiva de **WaveX Universal Music & Audiophile Streaming API**.  
Todos los endpoints están disponibles sobre el servidor HTTP local (por defecto `http://localhost:3000`).

---

## Tabla de Contenidos

1. [Arquitectura General y Convenciones](#1-arquitectura-general-y-convenciones)
2. [Catálogo de Proveedores (`:provider`), Calidades y Modos de Streaming](#2-catálogo-de-proveedores-provider-calidades-y-modos-de-streaming)
   - [Normalización Inteligente de Calidades](#21-normalización-inteligente-de-calidades-normalizeproviderquality)
   - [Garantía de Audio Puro (Sin Video Stream)](#22-garantía-de-audio-puro-sin-pistas-residuales-de-video)
   - [Modos de Operación: Modo Fijo vs. Modo Libre](#23-modos-de-operación-modo-fijo-vs-modo-libre)
3. [Fast Streaming 320 kbps (`/fast-streaming`)](#3-fast-streaming-320-kbps-fast-streaming)
4. [Streaming Audiófilo en Vivo y Caché de Audio](#4-streaming-audiófilo-en-vivo-y-caché-de-audio)
   - [`GET /api/stream/live`](#41-get-apistreamlive)
   - [`GET /api/stream/prefetch`](#42-get-apistreamprefetch)
   - [`POST /api/stream-full`](#43-post-apistream-full)
   - [`GET /api/stream/audio/:filename`](#44-get-apistreamaudiofilename)
   - [`GET /api/stream`](#45-get-apistream)
   - [`GET /downloads/:filename`](#46-get-downloadsfilename)
5. [Descargas, Conversión de Formato, Etiquetado y Lotes (.ZIP)](#5-descargas-conversión-de-formato-etiquetado-y-lotes-zip)
   - [`POST /api/:provider/download`](#51-post-apiproviderdownload)
   - [`POST /api/batch/download`](#52-post-apibatchdownload)
   - [`GET /api/batch/:jobId`](#53-get-apibatchjobid)
   - [`GET /api/batch/:jobId/zip`](#54-get-apibatchjobidzip)
   - [`GET /api/downloads/history`](#55-get-apidownloadshistory)
   - [`GET /api/events/progress` (SSE)](#56-get-apieventsprogress-sse)
6. [Búsqueda Universal, Autocompletado y Enriquecimiento](#6-búsqueda-universal-autocompletado-y-enriquecimiento)
   - [`GET /api/search`](#61-get-apisearch)
   - [`GET /api/suggest`](#62-get-apisuggest)
   - [`GET /api/track/enrich`](#63-get-apitrackenrich)
   - [`GET /api/resolve`](#64-get-apiresolve)
   - [`GET /api/track/resolve-providers`](#65-get-apitrackresolve-providers)
   - [`GET /api/album/match`](#66-get-apialbummatch)
7. [Letras Sincronizadas (`.LRC`) y Especificaciones `ffprobe`](#7-letras-sincronizadas-lrc-y-especificaciones-ffprobe)
   - [`GET /api/lyrics`](#71-get-apilyrics)
   - [`GET /api/audio/specs`](#72-get-apiaudiospecs)
8. [Endpoints Directos por Extensión (`/api/:provider/*`)](#8-endpoints-directos-por-extensión-apiprovider)
9. [Autenticación Turnstile y Sesiones Firmadas (`zarz-v2`)](#9-autenticación-turnstile-y-sesiones-firmadas-zarz-v2)
10. [Gestión de Extensiones (`.sflx`) y Auto-Actualización](#10-gestión-de-extensiones-sflx-y-auto-actualización)
    - [`GET /api/providers` (Catálogo y Estado)](#101-get-apiproviders-catálogo-y-estado-de-extensiones)
11. [Integración para Bots de Música (Discord, Telegram, WhatsApp) y Cola](#11-integración-para-bots-de-música-discord-telegram-whatsapp-y-cola)
    - [`GET /api/queue` y `GET /api/track/related`](#111-get-apiqueue-y-get-apitrackrelated-cola-y-recomendaciones)
    - [`GET /api/track/info`](#112-get-apitrackinfo-información-completa-de-canción)
    - [Flujo de Trabajo Típico de un Bot](#113-flujo-de-trabajo-típico-de-un-bot)
12. [Política de Retención y Auto-Purga (24 Horas) y Mantenimiento](#12-política-de-retención-y-auto-purga-24-horas-y-mantenimiento)
    - [`POST /api/maintenance/purge-expired`](#121-post-apimaintenancepurge-expired)

---

## 1. Arquitectura General y Convenciones

- **Base URL**: `http://localhost:3000`
- **Formato de Respuestas**: `application/json; charset=utf-8` para metadatos y control; flujos binarios (`audio/flac`, `audio/mpeg`, `audio/mp4`, `audio/ogg`, `application/zip`) para endpoints de reproducción y descarga.
- **Soporte Nativo de `HTTP 206 Partial Content` (`Accept-Ranges: bytes`)**:
  Todos los endpoints de streaming (`/fast-streaming`, `/api/stream/live`, `/api/stream/audio/:filename`, `/downloads/:filename`) soportan cabeceras `Range: bytes=START-END`. Esto permite **adelantar y atrasar (seeking)** en cualquier punto de la canción desde reproductores web `<audio>`, VLC, iOS/Android o clientes personalizados sin reiniciar la pista.
- **Caché de Doble Nivel (L1 RAM + L2 SQLite)**:
  WaveX almacena resoluciones de `ISRC`, `videoId` de YouTube Music, `qobuzId`, `tidalId`, letras `.lrc` e historial de descargas en `data/wavex_cache.sqlite` (modo WAL).

---

## 2. Catálogo de Proveedores (`:provider`), Calidades y Modos de Streaming

WaveX permite una arquitectura completamente abierta para la selección de fuentes de audio: el usuario puede optar por un **Modo Fijo** (ej. Qobuz 24-bit Hi-Res o Fast 320k) o un **Modo Libre**, donde puede elegir cualquier proveedor y calidad dinámicamente vía parámetros HTTP o en la interfaz gráfica.

### Tabla Oficial de Proveedores y Formatos

| ID de Proveedor (`:provider`) | Nombre | Calidades Soportadas (`quality`) | Formato Nativo |
| :--- | :--- | :--- | :--- |
| `qobuz-web` | **Qobuz** | `HI_RES_LOSSLESS` (24-bit/192kHz), `HI_RES` (24-bit/96kHz), `LOSSLESS` (16-bit/44.1kHz), `MP3_320` | `.flac` / `.mp3` |
| `tidal-web` | **TIDAL** | `HI_RES_LOSSLESS` (24-bit/192kHz), `LOSSLESS` (16-bit/44.1kHz), `HIGH` (320k AAC), `DOLBY_ATMOS` | `.flac` / `.m4a` |
| `amazon` | **Amazon Music** | `best` (Ultra HD 24-bit), `eac3` (Dolby Atmos Spatial), `opus` (320 kbps Opus) | `.flac` / `.eac3` |
| `ytmusic-spotiflac` | **YouTube Music** | `best` (Audio nativo Opus/AAC), `mp3_320` (vía `/fast-streaming`) | `.m4a` / `.opus` / `.mp3` |
| `deezer` | **Deezer** | `flac` (HiFi 16-bit/44.1kHz), `mp3_320`, `mp3_128` | `.flac` / `.mp3` |
| `soundcloud` | **SoundCloud** | `best`, `progressive`, `hls` | `.mp3` / `.m4a` |
| `apple-spotiflac` | **Apple Music** | `alac`, `aac_256`, `atmos` | `.m4a` |
| `spotify-web` | **Spotify Web** | Metadatos, playlists, álbumes, ISRC y resolución cruzada | JSON |
| `jiosaavn` | **JioSaavn** | `320`, `160`, `96` | `.m4a` |
| `bandcamp` | **Bandcamp** | `best`, `mp3-128` | `.mp3` / `.flac` |
| `beatport-spotiflac` | **Beatport** | Metadatos electrónicos, BPM, Key, ISRC | JSON |

---

### 2.1 Normalización Inteligente de Calidades (`normalizeProviderQuality`)

Para evitar errores tipográficos o discrepancias entre extensiones, WaveX procesa todas las peticiones con un **motor de normalización de calidad**. Puedes enviar tanto el identificador técnico estricto como términos coloquiales y la API seleccionará el formato correcto:

| Proveedor | Calidad Solicitada (Alias comunes aceptados) | Identificador Normalizado | Formato de Salida Real |
| :--- | :--- | :--- | :--- |
| **Qobuz** | `HI_RES_MAX`, `Hi-Res MAX`, `24bit`, `max`, `best`, `24-bit max` | `HI_RES_LOSSLESS` | **24-bit FLAC (hasta 192 kHz)** |
| **Qobuz** | `hi-res`, `hires`, `24` | `HI_RES` | 24-bit FLAC (hasta 96 kHz) |
| **Qobuz** | `lossless`, `cd`, `16bit`, `flac` | `LOSSLESS` | 16-bit FLAC (44.1 kHz) |
| **TIDAL** | `atmos`, `dolby_atmos`, `spatial` | `DOLBY_ATMOS` | Dolby Atmos E-AC-3 JOC |
| **TIDAL** | `max`, `hi-res`, `hires`, `24bit`, `best` | `HI_RES_LOSSLESS` | 24-bit HiRes FLAC |
| **TIDAL** | `lossless`, `16bit`, `flac` | `LOSSLESS` | 16-bit FLAC |
| **TIDAL** | `high`, `320`, `aac` | `HIGH` | AAC 320 kbps |
| **Amazon** | `atmos`, `eac3`, `ec3` | `eac3` | Dolby Atmos E-AC-3 |
| **Amazon** | `flac`, `lossless`, `hi-res`, `best`, `max` | `best` | FLAC 24-bit Ultra HD |
| **Amazon** | `opus`, `320` | `opus` | Opus 320 kbps |
| **Deezer** | `flac`, `lossless`, `hi-res`, `best` | `flac` | FLAC 16-bit 1411 kbps |
| **Deezer** | `320`, `mp3` | `mp3_320` | MP3 320 kbps |

---

### 2.2 Garantía de Audio Puro (Sin Pistas Residuales de Video)

En ciertas fuentes upstream (especialmente YouTube Music cuando actúa como fallback de un servicio de streaming), el archivo original puede venir empaquetado dentro de un contenedor MP4 con una pista de video estática H.264 (360x360 px) para mostrar la portada del álbum.

- **Comportamiento en Navegadores sin Filtro**: Al abrir la URL directamente en Google Chrome o Edge, el navegador detectaba el stream `h264` y abría el reproductor `<video>` con pantalla negra y botón de pantalla completa.
- **Mecanismo de Filtrado WaveX**: WaveX analiza los flujos multimedia con `ffprobe` e invoca automáticamente el subproceso `stripVideoIfPresent` (`ffmpeg -vn -c:a copy`). Este proceso remueve cualquier pista de video en menos de 0.2 segundos sin re-codificar el audio.  
- **Resultado**: Todas las respuestas son **100% audio puro (`codec_type=audio`)**, lo que garantiza que navegadores y reproductores externos siempre instancien el control nativo `<audio>`.

---

### 2.3 Modos de Operación: Modo Fijo vs. Modo Libre

1. **Modo Fijo (Por Defecto)**:
   - Configurado para entregar la máxima fidelidad audiófila con Qobuz (`provider=qobuz-web&quality=HI_RES_LOSSLESS`) o bien la mínima latencia con YouTube Music (`/fast-streaming` a 320 kbps MP3).
   - Ideal para usuarios y bots que sólo quieren presionar "Play" y obtener sonido de estudio sin configurar parámetros en cada petición.
2. **Modo Libre / Configurable**:
   - Permite al usuario o bot especificar explícitamente qué servicio y calidad desea para cada canción individual mediante los parámetros `provider` y `quality` en la URL de streaming o descarga.
   - En la interfaz web (`http://localhost:3000`), el botón **`⚙️ Calidad / Proveedor`** abre el panel interactivo donde se visualizan todos los proveedores disponibles y sus calidades para reproducir o descargar con un solo clic.

---

## 3. Fast Streaming Opus 320 kbps (`/fast-streaming`)

Endpoint dedicado de **reproducción inmediata y baja latencia** que conecta por defecto con **Amazon Music (`amazon`) en calidad Opus 320 kbps (`opus`)**.

Transmite el audio **por fragmentos progresivos (chunked stream / HTTP 206)** para que el reproductor comience a sonar en menos de 200 ms sin esperar a que la canción termine de descargarse.

> ⚡ **Inteligencia de Enlaces de YouTube**:
> Si se envía un enlace de YouTube (`url=https://www.youtube.com/watch?v=...` o `youtu.be/...` o `videoId=...`), el sistema **extrae automáticamente los metadatos oficiales (título y artista en 30ms)** y busca la pista en **Amazon Music (Opus 320 kbps)**. Si la pista es exclusiva de YouTube o no existe en Amazon, se transmite directamente desde **YouTube** como fallback transparente.

### Rutas Soportadas
- `GET /fast-streaming`
- `POST /fast-streaming`
- `GET /api/fast-streaming`
- `POST /api/fast-streaming`

### Parámetros (Query String en `GET` o JSON Body en `POST`)

| Parámetro | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `q`, `query`, `search` | `string` | Opcional* | **Búsqueda libre por texto**. El método más directo para buscar cualquier canción (ej. `q=Doja Cat Agora Hills`). |
| `title` | `string` | Opcional* | Título de la canción (ej. `title=Agora Hills`). |
| `artist` | `string` | Opcional | Nombre del artista (ej. `artist=Doja Cat`). |
| `trackId` / `id` / `asin` / `videoId` | `string` | Opcional* | **ID nativo de Amazon ASIN** (ej. `B0D43VBYR3`) o **ID de YouTube** (ej. `0QO5_QGS5ds`). |
| `isrc` | `string` | Opcional* | Código ISRC internacional de la pista (ej. `USRC12301954`). |
| `url` | `string` | Opcional* | Enlace de **YouTube, YouTube Music, Spotify, Apple Music o Amazon Music**. Si es de YouTube, extrae metadatos y reproduce vía Amazon Opus 320k (o fallback en YouTube si no existe en Amazon). |
| `json` o `format` | `string` | Opcional | Si se envía `json=1` o `format=json`, devuelve los metadatos y `audioSpecs` en JSON de inmediato (en ~30ms) en lugar del flujo binario de audio. |

> \*Debes enviar al menos un método de búsqueda: `q` (o `search`), `title`, `trackId`, `isrc` o `url`.

### Cabeceras de Respuesta (Modo Stream Binario Progresivo)
```http
HTTP/1.1 200 OK (o 206 Partial Content con Range)
Content-Type: audio/mp4
Accept-Ranges: bytes
Transfer-Encoding: chunked
X-Fast-Streaming-Provider: amazon
X-Audio-Codec: opus
X-Audio-Bitrate: 320kbps
```

### Ejemplos Prácticos de Búsqueda y Reproducción

#### 1. Buscar cualquier canción por texto libre (`?q=...`)
```html
<!-- HTML5 Audio directo: comienza a sonar en ~200ms por chunks -->
<audio controls preload="auto" src="http://localhost:3000/fast-streaming?q=Doja%20Cat%20Agora%20Hills"></audio>
```
```bash
# Reproducir o descargar stream Opus 320 kbps
curl -L "http://localhost:3000/fast-streaming?q=Doja%20Cat%20Agora%20Hills" --output "Agora_Hills_320k.m4a"
```

#### 2. Pasar un enlace de YouTube (`?url=https://youtube.com/watch?v=...`)
El endpoint extrae los metadatos del video de YouTube en 30 ms y reproduce la versión de alta calidad **Amazon Music Opus 320 kbps** (o reproduce directo de YouTube si no existe en Amazon):
```bash
curl -L "http://localhost:3000/fast-streaming?url=https://www.youtube.com/watch?v=0QO5_QGS5ds"
```

#### 3. Obtener JSON de información ultra-rápido (`?json=1`)
Ideal para bots de Discord / Telegram que necesitan resolver en ~30ms la carátula, duración y URLs de cola y streaming:
```bash
curl "http://localhost:3000/fast-streaming?q=Doja%20Cat%20Agora%20Hills&json=1"
```
**Respuesta JSON enriquecida (`200 OK`):**
```json
{
  "success": true,
  "cached": false,
  "provider": "amazon",
  "displayName": "Amazon Music (Fast Opus 320 kbps)",
  "trackId": "B0D43VBYR3",
  "id": "B0D43VBYR3",
  "title": "Agora Hills",
  "artist": "Doja Cat",
  "album": "Scarlet",
  "isrc": "USRC12301954",
  "coverUrl": "https://cdn-images.dzcdn.net/images/cover/57ea185ecde0635f7b02f245b9d67c96/1000x1000-000000-80-0-0.jpg",
  "durationSec": 265,
  "durationMs": 265000,
  "bitrate": "320 kbps",
  "codec": "opus",
  "audioSpecs": {
    "bitrate": "320 kbps",
    "codec": "opus",
    "sampleRate": 48000,
    "channels": 2,
    "badgeText": "48 kHz · 320 kbps · Opus (Amazon)"
  },
  "streamUrl": "/fast-streaming?trackId=B0D43VBYR3&title=Agora%20Hills&artist=Doja%20Cat",
  "fastStreamUrl": "/fast-streaming?trackId=B0D43VBYR3&title=Agora%20Hills&artist=Doja%20Cat",
  "liveStreamUrl": "/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat",
  "lyricsUrl": "/api/lyrics?title=Agora%20Hills&artist=Doja%20Cat&album=Scarlet&duration=265",
  "queueUrl": "/api/queue?title=Agora%20Hills&artist=Doja%20Cat",
  "relatedUrl": "/api/track/related?title=Agora%20Hills&artist=Doja%20Cat"
}
```
    "sizeBytes": 10618390,
    "container": "mp3",
    "isLossless": false,
    "isHiRes": false,
    "isAtmosOrSurround": false,
    "badgeText": "44.1 kHz · 320 kbps · MP3"
  },
  "streamUrl": "/fast-streaming?trackId=0QO5_QGS5ds&title=Agora%20Hills&artist=Doja%20Cat",
  "fastStreamUrl": "/fast-streaming?trackId=0QO5_QGS5ds&title=Agora%20Hills&artist=Doja%20Cat",
  "liveStreamUrl": "/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat",
  "lyricsUrl": "/api/lyrics?title=Agora%20Hills&artist=Doja%20Cat&album=Scarlet&duration=265",
  "queueUrl": "/api/queue?videoId=0QO5_QGS5ds&title=Agora%20Hills&artist=Doja%20Cat",
  "relatedUrl": "/api/track/related?videoId=0QO5_QGS5ds&title=Agora%20Hills&artist=Doja%20Cat"
}
```

#### 4. Reproducción directa por `trackId` (cuando ya conoces el videoId)
Si ya obtuviste el `videoId` (ej. `0QO5_QGS5ds`):
```bash
curl -L "http://localhost:3000/fast-streaming?trackId=0QO5_QGS5ds" --output "Agora_Hills.mp3"
```

---

## 4. Streaming Audiófilo en Vivo y Caché de Audio

### 4.1 `GET /api/stream/live`
Streaming progresivo por chunks con soporte completo de **`HTTP 206 Partial Content` (`Accept-Ranges: bytes`)**, resolución paralela (`LinkResolver` + `checkAvailability`), cadena de **Fallback Inteligente** (`qobuz-web` → `ytmusic-spotiflac` → `soundcloud` → `tidal-web` → `deezer`) y transcodificación **Dolby Atmos (`.eac3` → `FLAC 24-bit`)** en tiempo real para navegadores.

- **Importante**: Este endpoint almacena su caché temporal únicamente en `data/stream_cache/` y **nunca contamina** la carpeta `downloads/`.

#### Query Parameters
| Parámetro | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `title` | `string` | **Sí** | Título de la canción. |
| `artist` | `string` | Recomendado | Artista de la canción. |
| `isrc` | `string` | Opcional | Código ISRC para match exacto 1:1. |
| `provider` | `string` | Opcional | Proveedor preferido (por defecto `qobuz-web`). |
| `quality` | `string` | Opcional | Calidad deseada (`HI_RES_LOSSLESS`, `LOSSLESS`, `ATMOS`, `best`). |
| `trackId` | `string` | Opcional | ID nativo del proveedor si ya se conoce. |
| `browser` | `string` | Opcional | Enviar `1` si se reproduce desde un `<audio>` web para transcodificar `.eac3` Atmos a FLAC estéreo automáticamente. |
| `json` o `format` | `string` | Opcional | Enviar `json=1` o `format=json` para recibir los metadatos completos (álbum, ISRC, carátula HD, duración, specs) y `streamUrl` en JSON sin abrir el socket de audio. |

#### Ejemplo de Reproducción de Audio (Stream Binario HTTP 206)
```
GET http://localhost:3000/api/stream/live?title=Paint%20The%20Town%20Red&artist=Doja%20Cat&isrc=USRC12300907&provider=qobuz-web&quality=HI_RES_LOSSLESS&browser=1
```

#### Ejemplo de Consulta de Metadatos en JSON (`?json=1`)
```bash
curl "http://localhost:3000/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat&provider=qobuz-web&quality=HI_RES_LOSSLESS&json=1"
```
**Respuesta:**
```json
{
  "success": true,
  "cached": false,
  "provider": "qobuz-web",
  "quality": "HI_RES_LOSSLESS",
  "title": "Agora Hills",
  "artist": "Doja Cat",
  "album": "Scarlet",
  "isrc": "USRC12301954",
  "coverUrl": "https://cdn-images.dzcdn.net/images/cover/57ea185ecde0635f7b02f245b9d67c96/1000x1000-000000-80-0-0.jpg",
  "durationSec": 265,
  "durationMs": 265000,
  "audioSpecs": {
    "codec": "flac",
    "sampleRate": 96000,
    "bitDepth": 24
  },
  "streamUrl": "/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat&provider=qobuz-web&quality=HI_RES_LOSSLESS",
  "fastStreamUrl": "/fast-streaming?title=Agora%20Hills&artist=Doja%20Cat",
  "lyricsUrl": "/api/lyrics?title=Agora%20Hills&artist=Doja%20Cat&album=Scarlet&duration=265",
  "queueUrl": "/api/queue?title=Agora%20Hills&artist=Doja%20Cat",
  "relatedUrl": "/api/track/related?title=Agora%20Hills&artist=Doja%20Cat"
}
```

---

### 4.2 `GET /api/stream/prefetch`
Pre-resuelve los IDs nativos de todos los proveedores en segundo plano y, opcionalmente, pre-calienta el archivo de audio en `data/stream_cache/` (usado para **Hover Pre-fetching** y **Gapless Playback** 15 segundos antes de que termine la canción actual).

#### Query Parameters
- `title` (**requerido**), `artist`, `isrc`, `provider`, `quality`
- `warmAudio`: Si es `1`, descarga silenciosamente el stream en `data/stream_cache/`.

---

### 4.3 `POST /api/stream-full`
Pre-almacena la pista completa en `data/stream_cache/` y devuelve la URL local con soporte de rangos (`/api/stream/audio/:filename`).

#### Request Body
```json
{
  "title": "Kiss Me More",
  "artist": "Doja Cat",
  "isrc": "USRC12100523",
  "provider": "qobuz-web",
  "quality": "HI_RES_LOSSLESS"
}
```

---

### 4.4 `GET /api/stream/audio/:filename`
Sirve cualquier archivo desde `data/stream_cache/` (o `downloads/` si se envía `?source=downloads`) con soporte `HTTP 206 Partial Content` (`Accept-Ranges: bytes`).

---

### 4.5 `GET /api/stream`
Obtiene o redirige a la muestra rápida de 30 segundos (Octave / Apple Music / Deezer preview).
- **Query Params**: `id` (ID de Octave/Deezer) o `q` (búsqueda), `redirect=true|false`.

---

### 4.6 `GET /downloads/:filename`
Sirve un archivo descargado permanentemente en la carpeta `downloads/` con soporte `HTTP 206 Partial Content`.

---

## 5. Descargas, Conversión de Formato, Etiquetado y Lotes (.ZIP)

### 5.1 `POST /api/:provider/download`
Descarga una canción de forma permanente en la carpeta `downloads/`, ejecuta el **Post-Procesador Audiófilo** (`AudioProcessor`):
1. Convierte al formato solicitado si se especifica `format` (`mp3_320`, `flac`, `alac`, `aac`, `wav`).
2. Analiza las especificaciones reales con `ffprobe` (`bitDepth`, `sampleRate`, `bitrateKbps`, `codec`, `channelLayout`).
3. Descarga las letras sincronizadas `.lrc` desde LRCLIB y guarda el archivo `.lrc` compañero.
4. Incrusta etiquetas completas (`ID3v2.4` / `Vorbis Comments` / `MP4 Atoms`: título, artista, álbum, fecha, ISRC, letras) y **portada en alta resolución (hasta 3000x3000 px)** usando `ffmpeg`.
5. Registra la descarga en el historial persistente SQLite.

#### Path Parameter
- `:provider`: ID de la extensión (`qobuz-web`, `tidal-web`, `amazon`, `ytmusic-spotiflac`, `deezer`, `soundcloud`, etc.).

#### Request Body
```json
{
  "trackId": "248271494",
  "quality": "HI_RES_LOSSLESS",
  "title": "Paint The Town Red",
  "artist": "Doja Cat",
  "album": "Scarlet",
  "isrc": "USRC12300907",
  "coverUrl": "https://is1-ssl.mzstatic.com/image/thumb/.../3000x3000bb.jpg",
  "format": "flac"
}
```
> Nota: Si `trackId` es un ISRC o título, WaveX resuelve automáticamente el ID numérico/nativo real del proveedor antes de descargar.

#### Respuesta (`200 OK`)
```json
{
  "success": true,
  "cached": false,
  "provider": "qobuz-web",
  "displayName": "Qobuz",
  "trackId": "248271494",
  "quality": "HI_RES_LOSSLESS",
  "fileName": "Doja Cat - Paint The Town Red [qobuz-web-HI_RES_LOSSLESS].flac",
  "outputPath": "C:\\Users\\oscar\\Desktop\\WaveX\\downloads\\Doja Cat - Paint The Town Red [qobuz-web-HI_RES_LOSSLESS].flac",
  "sizeBytes": 46051373,
  "audioSpecs": {
    "codec": "flac",
    "container": "flac",
    "sampleRate": 44100,
    "bitsPerSample": 24,
    "bitrateKbps": 1658,
    "channels": 2,
    "channelLayout": "stereo",
    "durationSec": 231.4,
    "isLossless": true,
    "isHiRes": true,
    "isAtmosOrSurround": false,
    "badgeText": "24-bit / 44.1 kHz · 1658 kbps FLAC"
  },
  "tagged": true,
  "hasSyncedLyrics": true,
  "lrcFile": "Doja Cat - Paint The Town Red [qobuz-web-HI_RES_LOSSLESS].lrc",
  "streamUrl": "/downloads/Doja%20Cat%20-%20Paint%20The%20Town%20Red%20%5Bqobuz-web-HI_RES_LOSSLESS%5D.flac"
}
```

---

### 5.2 `POST /api/batch/download`
Inicia un trabajo en segundo plano para descargar un álbum o lista de canciones con concurrencia controlada (`2 workers` paralelos), etiquetado completo y generación de `.lrc`.

#### Request Body
```json
{
  "albumTitle": "Scarlet",
  "provider": "qobuz-web",
  "quality": "HI_RES_LOSSLESS",
  "tracks": [
    {
      "title": "Paint The Town Red",
      "artist": "Doja Cat",
      "album": "Scarlet",
      "isrc": "USRC12300907",
      "coverUrl": "https://..."
    }
  ]
}
```

#### Respuesta
```json
{
  "success": true,
  "jobId": "batch_1792895000_a1b2c3",
  "statusUrl": "/api/batch/batch_1792895000_a1b2c3",
  "zipUrl": "/api/batch/batch_1792895000_a1b2c3/zip"
}
```

---

### 5.3 `GET /api/batch/:jobId`
Consulta el estado y progreso individual de cada canción dentro de un lote de descarga.

---

### 5.4 `GET /api/batch/:jobId/zip`
Descarga un archivo `.zip` generado al vuelo con todas las pistas completadas del lote y sus respectivos archivos `.lrc` de letras sincronizadas.

---

### 5.5 `GET /api/downloads/history`
Devuelve el historial persistente almacenado en SQLite de todas las descargas realizadas, incluyendo sus especificaciones `ffprobe`.
- **Query Param**: `limit` (por defecto `50`, máx `200`).

---

### 5.6 `GET /api/events/progress` (SSE)
Flujo **Server-Sent Events (`text/event-stream`)** que emite eventos cada `120ms` durante cualquier descarga o stream activo.

#### Ejemplo de Evento SSE
```json
{
  "type": "download_progress",
  "filePath": "C:\\...\\Doja Cat - Woman [qobuz-web-HI_RES_LOSSLESS].flac",
  "fileName": "Doja Cat - Woman [qobuz-web-HI_RES_LOSSLESS].flac",
  "bytesReceived": 18450200,
  "totalBytes": 36900400,
  "percent": 50,
  "speedMBps": 14.25,
  "status": "downloading"
}
```

---

## 6. Búsqueda Universal, Autocompletado y Enriquecimiento

### 6.1 `GET /api/search`
Motor de búsqueda universal ultra-rápido con caché persistente L1/L2.

#### Query Parameters
| Parámetro | Tipo | Por Defecto | Descripción |
| :--- | :--- | :--- | :--- |
| `q` | `string` | **Requerido** | Término de búsqueda (canción, artista, álbum). |
| `mode` | `string` | `octave-enriched` | Modo de búsqueda: `octave-enriched` (Octave + Apple Music en paralelo), `apple-music` (iTunes/Apple nativo), o cualquier ID de extensión (`qobuz-web`, `tidal-web`, `spotify-web`, `ytmusic-spotiflac`, `deezer`, `soundcloud`). |
| `limit` | `number` | `15` | Número máximo de resultados. |
| `fast` | `string` | `1` | Enriquecimiento rápido instantáneo. |

---

### 6.2 `GET /api/suggest`
Sugerencias de autocompletado en tiempo real (`< 50ms`) con artistas, álbumes y canciones.
- **Query Params**: `q` (**requerido**), `limit` (por defecto `6`).

---

### 6.3 `GET /api/track/enrich`
Enriquece bajo demanda una pista con metadatos profundos de **Apple Music** (compositores, fecha exacta de lanzamiento, número de disco/pista, `is_dolby_atmos`, `is_lossless`, `is_hi_res`, portada `3000x3000`).
- **Query Params**: `title` (**requerido**), `artist`, `isrc`, `id` (ID de Octave/Deezer para obtener ISRC exacto).

---

### 6.4 `GET /api/resolve`
Resuelve cualquier URL musical (Spotify, Apple Music, YouTube, TIDAL, Qobuz, Deezer, SoundCloud) a través de `LinkResolver` (Odesli/Songlink + MusicBrainz + Deezer ISRC) y devuelve los enlaces y IDs nativos en todas las plataformas.
- **Query Param**: `url` (**requerido**).

---

### 6.5 `GET /api/track/resolve-providers`
Verifica en paralelo qué proveedores de descarga tienen disponible una canción y devuelve sus IDs nativos (`qobuzId`, `tidalId`, `amazonAsin`, `deezerId`, `youtubeVideoId`) junto con el listado de calidades (`qualities`) de cada proveedor.
- **Query Params**: `title` (**requerido**), `artist`, `isrc`.

---

### 6.6 `GET /api/album/match`
Compara y vincula un álbum de Octave/Deezer con Apple Music usando el código de barras **UPC** y los códigos **ISRC** de cada pista.
- **Query Param**: `id` (**requerido**, ej. `238876612`).

---

## 7. Letras Sincronizadas (`.LRC`) y Especificaciones `ffprobe`

### 7.1 `GET /api/lyrics`
Obtiene letras sincronizadas con marcas de tiempo `[mm:ss.xx]` (`.lrc`) y letras en texto plano desde LRCLIB (con caché en SQLite).
- **Query Params**: `title` (**requerido**), `artist`, `album`, `duration` (segundos).

#### Respuesta
```json
{
  "found": true,
  "instrumental": false,
  "syncedLyrics": "[00:12.40] Hey, woman\n[00:15.10] Let me be your woman...",
  "plainLyrics": "Hey, woman\nLet me be your woman..."
}
```

---

### 7.2 `GET /api/audio/specs`
Analiza mediante `ffprobe` un archivo en `downloads/` o `data/stream_cache/` y devuelve sus propiedades acústicas reales.
- **Query Params**: `fileName` (nombre de archivo) **o** `title` + `artist` (+ `provider`, `quality`).

---

## 8. Endpoints Directos por Extensión (`/api/:provider/*`)

Puedes invocar directamente cualquier extensión instalada (`.sflx`):
- `GET /api/:provider/search?q=Doja%20Cat&filter=tracks`
- `GET /api/:provider/track/:id`
- `GET /api/:provider/album/:id`
- `GET /api/:provider/playlist/:id`
- `GET /api/:provider/artist/:id`
- `POST /api/:provider/match` — Body: `{ "metadata": { "title": "...", "artist": "...", "isrc": "..." } }`
- `POST /api/:provider/call` — RPC directo a cualquier función exportada por la extensión:
  ```json
  {
    "method": "checkAvailability",
    "args": ["USRC12300907", "Paint The Town Red", "Doja Cat", {}]
  }
  ```

---

## 9. Autenticación Turnstile y Sesiones Firmadas (`zarz-v2`)

WaveX incluye el daemon **`SessionKeeper`** y **`AutoTurnstileSolver`**, que mantienen autenticadas y renovadas automáticamente (`POST /session/refresh` con firma HMAC) las sesiones de `qobuz-web`, `tidal-web` y `amazon`. Además expone:
- `GET /api/auth/turnstile/url?provider=qobuz-web` — Genera URL de reto Turnstile o informa si ya está autenticado.
- `POST /api/auth/turnstile/solve-auto` — Ejecuta el solver automático en segundo plano y sincroniza la sesión en todas las extensiones.
- `POST /api/auth/turnstile/open?provider=qobuz-web` — Abre el reto en el navegador del sistema.
- `POST /api/auth/turnstile/exchange` — Canjea manualmente un `grant` (`{ "provider": "qobuz-web", "grant": "gr_..." }`).
- `GET /api/auth/turnstile/wait?provider=qobuz-web&timeout=75000` — Long-polling hasta que se complete la verificación.

---

## 10. Gestión de Extensiones (`.sflx`) y Auto-Actualización

### 10.1 `GET /api/providers` (Catálogo y Estado de Extensiones)
Devuelve la lista completa de todas las extensiones instaladas y activas en el motor WaveX, detallando sus tipos (`metadata_provider`, `download_provider`), su catálogo exacto de calidades (`qualities`), su calidad recomendada por defecto (`defaultQuality`), si requieren sesión firmada (`requiresAuth`) y si dicha sesión se encuentra activa (`isAuthenticated`).

- **Rutas Soportadas**: `GET /api/providers`, `GET /api/providers/all`, `GET /api/providers/download-options`

#### Ejemplo de Petición
```bash
curl "http://localhost:3000/api/providers"
```

#### Ejemplo de Respuesta JSON
```json
{
  "success": true,
  "count": 12,
  "providers": [
    {
      "id": "qobuz-web",
      "name": "Qobuz",
      "version": "1.2.25",
      "description": "Qobuz metadata and download provider...",
      "type": ["metadata_provider", "download_provider"],
      "isDownloadProvider": true,
      "isMetadataProvider": true,
      "requiresAuth": true,
      "isAuthenticated": true,
      "defaultQuality": "HI_RES_LOSSLESS",
      "qualities": [
        {
          "id": "HI_RES_LOSSLESS",
          "label": "24-Bit Max",
          "description": "Attempt the highest Qobuz hi-res quality first",
          "kind": "lossless"
        },
        {
          "id": "HI_RES",
          "label": "24-Bit",
          "description": "Prefer 24-bit Qobuz quality",
          "kind": "lossless"
        },
        {
          "id": "LOSSLESS",
          "label": "Lossless",
          "description": "Fallback to standard Qobuz lossless quality",
          "kind": "lossless"
        }
      ],
      "capabilities": {
        "downloadFallbackTier": "lossless",
        "networkTimeoutSeconds": 15
      },
      "exampleStreamUrl": "/api/stream/live?title=Agora%20Hills&artist=Doja%20Cat&provider=qobuz-web&quality=HI_RES_LOSSLESS"
    }
  ]
}
```

---

### 10.2 Otras Rutas de Gestión de Extensiones
- `GET /installed` — Lista las extensiones instaladas en `extensions/`.
- `GET /store` — Consulta el catálogo oficial remoto de extensiones SpotiFLAC/Mornye.
- `POST /install/:id` — Instala o actualiza una extensión específica desde el repositorio oficial.
- `POST /update-all` — Busca e instala actualizaciones para todas las extensiones instaladas en caliente.
- `DELETE /uninstall/:id` — Desinstala una extensión.
- `GET /api/docs` — Devuelve esta documentación completa en formato JSON o Markdown (`?format=markdown`).

---

## 11. Integración para Bots de Música (Discord, Telegram, WhatsApp) y Cola

WaveX está optimizado para actuar como backend de streaming de bots de audio (como bots de Discord basados en `@discordjs/voice`, bots de Telegram o reproductores multimedia headless).

### 11.1 `GET /api/queue` y `GET /api/track/related` (Cola y Recomendaciones)

Devuelve automáticamente una lista de canciones recomendadas (autoplay / queue) calculadas a partir de una pista semilla mediante el algoritmo de similitud musical de YouTube Music y metadatos cruzados.

#### Query Parameters
| Parámetro | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `videoId` o `trackId` | `string` | Recomendado | ID de 11 caracteres de YouTube Music de la pista actual (ej. `0QO5_QGS5ds`). |
| `title` | `string` | Opcional | Título de la pista si no se conoce el ID. |
| `artist` | `string` | Opcional | Artista de la pista. |
| `limit` | `number` | Opcional | Número de canciones a generar en la cola (por defecto `15`, máx `50`). |

#### Ejemplo de Petición
```bash
curl "http://localhost:3000/api/queue?videoId=0QO5_QGS5ds&limit=5"
```

#### Ejemplo de Respuesta JSON
```json
{
  "success": true,
  "seed": {
    "videoId": "0QO5_QGS5ds",
    "title": "Agora Hills",
    "artist": "Doja Cat"
  },
  "count": 5,
  "queue": [
    {
      "id": "USb5JBhZed0",
      "videoId": "USb5JBhZed0",
      "title": "Need to Know",
      "artist": "Doja Cat",
      "album": "Planet Her",
      "coverUrl": "https://yt3.googleusercontent.com/LKHANNfV6CM0WCxrjdjOojWY8N6FSywKXMFbBSXfvtfZ6Fh1ysadjuFl0L266zthTJvnSc6BjBzf7MoEQA=w512-h512-l90-rj",
      "durationSec": 211,
      "durationMs": 211000,
      "fastStreamUrl": "/fast-streaming?trackId=USb5JBhZed0&title=Need%20to%20Know&artist=Doja%20Cat",
      "streamUrl": "/api/stream/live?title=Need%20to%20Know&artist=Doja%20Cat",
      "lyricsUrl": "/api/lyrics?title=Need%20to%20Know&artist=Doja%20Cat&duration=211"
    }
  ]
}
```

---

### 11.2 `GET /api/track/info` (Información Completa de Canción)

Resuelve y devuelve la ficha completa de cualquier canción con enlaces directos a todas las plataformas mundiales (Spotify, Apple Music, Deezer, TIDAL, Qobuz, Amazon Music, YouTube), carátula HD (1000x1000), ISRC, álbum y duración.

#### Query Parameters
- `title` y `artist` **o** `url` **o** `isrc` **o** `videoId`.

#### Ejemplo de Petición
```bash
curl "http://localhost:3000/api/track/info?title=Agora%20Hills&artist=Doja%20Cat"
```

---

### 11.3 Flujo de Trabajo Típico de un Bot de Música

1. **Usuario escribe en Discord / Telegram**:  
   `!play Agora Hills Doja Cat`
2. **El Bot consulta metadatos con `json=1`**:  
   `GET http://localhost:3000/fast-streaming?q=Agora%20Hills%20Doja%20Cat&json=1`
3. **El Bot responde en el chat con un Rich Embed**:
   - Título: `Agora Hills`
   - Artista: `Doja Cat`
   - Álbum: `Scarlet`
   - ISRC: `USRC12301954`
   - Carátula: `coverUrl` (1000x1000 px)
   - Duración: `durationSec` (265 seg)
4. **El Bot inicia la reproducción de audio**:
   - Conecta el stream de audio directo a `@discordjs/voice` o FFmpeg apuntando a:  
     `http://localhost:3000/fast-streaming?trackId=0QO5_QGS5ds`
5. **Autoplay / Cola Inteligente**:
   - Cuando la canción está por terminar o la cola se vacía, el Bot consulta:  
     `GET http://localhost:3000/api/queue?videoId=0QO5_QGS5ds&limit=10`
   - Agrega automáticamente los siguientes temas con sus `fastStreamUrl`.

---

## 12. Política de Retención y Auto-Purga (24 Horas) y Mantenimiento

Para mantener el disco libre de archivos acumulados y evitar consumo descontrolado de espacio, WaveX cuenta con un **sistema de auto-limpieza periódica**:

- **Regla de 24 Horas**: Todo archivo descargado o en caché dentro de:
  - `downloads/`
  - `data/stream_cache/`  
  cuya fecha de última modificación (`mtime`) supere las **24 horas** (`86,400,000 ms`), es eliminado automáticamente del disco.
- **Archivos Temporales**: Archivos parciales huérfanos (`.part`, `.tmp`) de descargas interrumpidas se purgan si tienen más de **30 minutos**.
- **Frecuencia**: El servicio de mantenimiento se ejecuta **al iniciar el servidor** y luego **periódicamente cada 30 minutos** en segundo plano sin interrumpir el streaming.

### 12.1 `POST /api/maintenance/purge-expired` (y `GET`)
Permite forzar la ejecución manual de la limpieza y obtener el resumen de espacio liberado.

#### Respuesta
```json
{
  "success": true,
  "message": "Se eliminaron 5 archivo(s) expirados (>24h).",
  "freedBytes": 52428800,
  "freedMb": 50.00,
  "deletedFiles": [
    "Clairo - Add Up My Love [qobuz-web-HI_RES_LOSSLESS].m4a",
    "Don Toliver - Lose My Mind [jiosaavn-AAC_320].m4a"
  ],
  "errors": []
}
```


---

## Verificación real de proveedores — GET /api/resolve-track-providers

Parámetros: 	itle (obligatorio), rtist, isrc, ideoId o url (enlace de YouTube), strict (por defecto 1; con strict=0 lista todos los proveedores sin verificar).

En modo estricto solo se listan los proveedores donde la canción **realmente existe**. YouTube Music siempre queda como última opción. Cada proveedor trae erified y erifiedBy:

| erifiedBy | Significado |
|---|---|
| checkAvailability | El propio proveedor confirmó la pista (solo con ISRC confiable) |
| search:isrc / search:title+artist | Una búsqueda en el proveedor devolvió una pista con el mismo ISRC, o con el mismo título y artista |
| esolver:isrc | ID de Qobuz/Tidal/Deezer obtenido por ISRC confiable |
| user-youtube-link | El usuario envió ese enlace de YouTube |

El ISRC que devuelve el resolvedor se valida contra Deezer (título y artista). Si no coincide, se descartan los enlaces. Así una canción que solo está en YouTube devuelve únicamente ytmusic-spotiflac.
