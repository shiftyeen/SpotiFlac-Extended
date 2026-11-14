# WaveX API & Music Explorer 🎵

Lightweight, high-performance Music Metadata and Download REST API built in **TypeScript** / **Node.js** powered by SpotiFLAC/Mornye `.sflx` extensions with **Octave Streaming** search and **Apple Music** metadata enrichment.

---

## 🌟 Novedades y Características

- ⚡ **12 Extensiones Modulares Instaladas**:
  - `spotify-web`, `apple-music`, `amazon`, `deezer`, `ytmusic-spotiflac`, `tidal-web`, `qobuz-web`, `soundcloud`, `jiosaavn`, `bugs-music`, `melon-music`, `genie-music`.
- 🔎 **Buscador Universal Octave + Apple Music**:
  - Consulta en tiempo real las APIs de Octave Streaming (`/api/search/page` y `/api/suggest`).
  - Enriquecimiento automático de tracks con metadatos reales de **Apple Music** (ISRC, UPC, Compositor, Dolby Atmos, Audio Espacial, Letras Sincronizadas y Portadas en 3000x3000px).
- 🎧 **Página Web de Pruebas Interactiva**:
  - Interfaz moderna en `http://localhost:3000` con dark mode, glassmorphism, sugerencias en vivo, modal de inspección de metadatos y reproductor de audio integrado (previews de 30s).
- 🔒 **Aislamiento Seguro con Worker Threads**:
  - Ejecución en hilos dedicados (`node:worker_threads`) con puente síncrono sobre `SharedArrayBuffer` y `Atomics.wait`.

---

## 🚀 Inicio Rápido

### Modo Desarrollo
```bash
npm run dev
```

Abre tu navegador en:
```
http://localhost:3000
```

### VPS Linux sin escritorio: Chromium + Xvfb

WaveX puede abrir el challenge en Chromium aunque la VPS solo se administre por SSH. En Ubuntu/Debian instala una vez:

```bash
sudo apt-get update
sudo apt-get install -y chromium xvfb
```

Cuando un proveedor solicite verificación, WaveX inicia Chromium dentro de una pantalla virtual con `xvfb-run`, espera el callback, guarda la sesión y cierra Chromium. Los perfiles persistentes se guardan por defecto en `data/chromium-profile/<provider>`. `SessionKeeper` solo renueva sesiones existentes y no arranca Mornye-Python por defecto.

Variables opcionales:

- `CHROMIUM_PATH`: ruta absoluta a Chromium si no está en una ubicación habitual.
- `XVFB_RUN_PATH`: ruta absoluta a `xvfb-run`.
- `WAVEX_CHROMIUM_PROFILE_DIR`: directorio donde guardar los perfiles persistentes.
- `WAVEX_CHROMIUM_NO_SANDBOX=1`: solo para contenedores donde Chromium se ejecute como root. Es preferible ejecutar WaveX con un usuario sin privilegios y conservar el sandbox.

Puedes comprobar el flujo con `POST /api/auth/turnstile/open?provider=amazon`. Si Turnstile exige interacción, el navegador permanecerá abierto hasta recibir el callback o hasta agotar el tiempo de espera; WaveX no simula clics.

---

## 📡 Endpoints de la API

### 1. Búsqueda Octave & Enriquecimiento Apple Music
| Método | Endpoint | Parámetros | Descripción |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/octave/search` | `?q=Doja+Cat&limit=30` | Búsqueda estándar en Octave Streaming |
| `GET` | `/api/octave/suggest` | `?q=i+think+he&limit=5` | Autocompletado y sugerencias rápidas con previews de audio |
| `GET` | `/api/octave/search-enriched` | `?q=cancion&limit=20` | Búsqueda en Octave con **metadatos de Apple Music** enriquecidos automáticamente |
| `POST` | `/api/enrich/apple-music` | Body JSON | Enriquecer cualquier objeto track `{ name, artists, isrc, ... }` con Apple Music |

### 2. Estado y Catálogo de Extensiones
| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| `GET` | `/api/status` | Estado de la API y lista de extensiones activas |
| `GET` | `/registry` | Catálogo de extensiones en GitHub |
| `GET` | `/installed` | Extensiones instaladas localmente |
| `POST` | `/install/:id` | Instalar una extensión desde el registro |

### 3. Búsqueda y Metadatos por Proveedor
| Método | Endpoint | Proveedores disponibles |
| :--- | :--- | :--- |
| `GET` | `/api/:provider/search?q=...` | `spotify-web`, `apple-music`, `deezer`, `ytmusic-spotiflac`, `tidal-web`, etc. |
| `GET` | `/api/:provider/track/:id` | Metadatos directos del proveedor |
| `GET` | `/api/:provider/album/:id` | Información completa del álbum |
| `GET` | `/api/:provider/feed` | Home feed / recomendaciones |
| `GET` | `/api/resolve?url=...` | Resolver cualquier URL de música |
| `POST` | `/api/:provider/download` | Iniciar descarga con streaming |

---

## 📦 Scripts Disponibles

- `npm run dev`: Inicia el servidor con recarga en caliente (`tsx watch`).
- `npm start`: Inicia el servidor directamente con Node/TSX.
- `npx tsx scripts/install-all.ts`: Descarga e instala todas las extensiones del catálogo.
