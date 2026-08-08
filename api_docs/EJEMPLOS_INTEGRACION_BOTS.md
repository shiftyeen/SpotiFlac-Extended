# 🤖 Guía de Integración para Bots (Discord, Telegram y Scripts)

Esta guía contiene ejemplos listos para producción en **Node.js (Axios / Discord.js)**, **Python (aiohttp)** y **cURL** para integrar la API de SpotiFLAC Extended en tus propios bots de Discord, Telegram o scripts de automatización.

---

## 🟢 1. Ejemplo en Node.js (Axios + WebSockets / Discord.js)

Este código inicia la descarga en calidad `LOSSLESS`, espera a que el progreso sea 100% (escuchando por WebSocket o haciendo polling) y luego obtiene el archivo `.flac` final listo para enviar como adjunto en Discord o guardar en disco.

```javascript
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const API_BASE = 'http://localhost:8080/api/v1'; // O la URL de tu VPS / Túnel Cloudflare

async function downloadTrackAndGetFLAC(spotifyUrl) {
  try {
    console.log('1. Creando tarea de descarga...');
    const createRes = await axios.post(`${API_BASE}/downloads`, {
      url: spotifyUrl,
      quality: 'LOSSLESS', // 'HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH'
      services: ['ext:tidal-web', 'ext:qobuz-web', 'amazon', 'qobuz', 'deezer', 'youtube'],
      embed_lyrics: true,
      enrich_metadata: true
    });

    const taskId = createRes.data.task.task_id;
    console.log(`2. Tarea creada con ID: ${taskId}`);

    // Polling hasta completar
    let completed = false;
    while (!completed) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await axios.get(`${API_BASE}/tasks/${taskId}`);
      const task = statusRes.data;

      console.log(`Progreso: ${task.progress_percent}% - Estado: ${task.status}`);

      if (task.status === 'completed') {
        completed = true;
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        throw new Error(`Tarea falló o fue cancelada: ${JSON.stringify(task.logs)}`);
      }
    }

    console.log('3. Descargando archivo de audio final...');
    const fileRes = await axios.get(`${API_BASE}/files/${taskId}`, {
      responseType: 'arraybuffer'
    });

    // Obtener nombre del archivo desde los headers o generarlo
    const contentDisposition = fileRes.headers['content-disposition'];
    let filename = `track_${taskId.substring(0, 8)}.flac`;
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    const outputPath = path.join(__dirname, filename);
    fs.writeFileSync(outputPath, fileRes.data);
    console.log(`✅ Archivo FLAC guardado con éxito en: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('❌ Error en descarga:', error.message);
    throw error;
  }
}

// Probar función
downloadTrackAndGetFLAC('https://open.spotify.com/intl-es/track/0m2UVJS2dZjXtbi0tB2A0t');
```

---

## 🐍 2. Ejemplo en Python (aiohttp + asyncio)

```python
import asyncio
import aiohttp
from pathlib import Path

API_BASE = "http://localhost:8080/api/v1"

async def download_spotify_track(spotify_url: str, output_path: str = "./downloads"):
    async with aiohttp.ClientSession() as session:
        print("1. Enviando petición de descarga...")
        payload = {
            "url": spotify_url,
            "quality": "LOSSLESS",
            "services": ["ext:tidal-web", "ext:qobuz-web", "amazon", "qobuz", "deezer"],
            "embed_lyrics": True,
            "enrich_metadata": True
        }
        
        async with session.post(f"{API_BASE}/downloads", json=payload) as resp:
            data = await resp.json()
            task_id = data["task"]["task_id"]
            print(f"2. Tarea iniciada: {task_id}")

        # Polling del estado
        while True:
            await asyncio.sleep(2.0)
            async with session.get(f"{API_BASE}/tasks/{task_id}") as resp:
                task = await resp.json()
                status = task.get("status")
                progress = task.get("progress_percent", 0.0)
                print(f"Progreso: {progress:.1f}% | Estado: {status}")

                if status == "completed":
                    break
                elif status in ("failed", "cancelled"):
                    raise RuntimeError(f"Error en la tarea: {task.get('logs')}")

        print("3. Descargando archivo .flac resultante...")
        async with session.get(f"{API_BASE}/files/{task_id}") as resp:
            if resp.status == 200:
                dest_dir = Path(output_path)
                dest_dir.mkdir(parents=True, exist_ok=True)
                
                # Extraer nombre del archivo
                disp = resp.headers.get("Content-Disposition", "")
                filename = f"audio_{task_id[:8]}.flac"
                if "filename=" in disp:
                    filename = disp.split("filename=")[-1].strip('"')
                
                final_file = dest_dir / filename
                final_file.write_bytes(await resp.read())
                print(f"✅ Descarga completada en: {final_file}")
                return str(final_file)

if __name__ == "__main__":
    asyncio.run(download_spotify_track("https://open.spotify.com/intl-es/track/0m2UVJS2dZjXtbi0tB2A0t"))
```

---

## 🐚 3. Comandos cURL para Pruebas en Consola Bash / Terminal

### 1. Iniciar Descarga
```bash
curl -X POST "http://localhost:8080/api/v1/downloads" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://open.spotify.com/intl-es/track/0m2UVJS2dZjXtbi0tB2A0t",
       "quality": "LOSSLESS",
       "services": ["ext:tidal-web", "ext:qobuz-web", "amazon", "deezer"]
     }'
```

### 2. Consultar Estado de la Tarea (Reemplazar TASK_ID)
```bash
curl -X GET "http://localhost:8080/api/v1/tasks/TASK_ID_AQUI"
```

### 3. Descargar Archivo FLAC Resultante
```bash
curl -X GET "http://localhost:8080/api/v1/files/TASK_ID_AQUI" --output "cancion.flac"
```
