# 🔌 Proveedores Nativos y Extensiones JS en SpotiFLAC Extended

SpotiFLAC Extended utiliza una arquitectura híbrida de doble capa para obtener música en máxima calidad:
1. **Proveedores Nativos (Python)**: Integrados directamente en el core del motor.
2. **Extensiones JavaScript (JSExtensions / `.sflx`)**: Módulos asíncronos desacoplados que ejecutan en un Process Pool de Node.js multihilo, permitiendo una velocidad de descarga masiva en paralelo.

---

## 📋 Tabla Comparativa de Proveedores

| ID Proveedor / Extensión | Tipo | Formatos Soportados | Calidad Máxima | Requiere Cuenta / Captcha | Descripción / Notas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`ext:tidal-web`** *(Default 1)* | Extensión JS | FLAC, M4A, Atmos | 24-Bit / 192kHz | ⚠️ Ocasional (Turnstile) | **Proveedor Principal FLAC/Hi-Res**. Utiliza la API web pública de Tidal sin requerir suscripción. |
| **`ext:qobuz-web`** *(Default 2)* | Extensión JS | FLAC | 24-Bit / 192kHz | ⚠️ Ocasional (Turnstile) | **Proveedor Principal Qobuz**. Catálogo masivo audiófilo Hi-Res en FLAC nativo. |
| **`amazon`** | Nativo | FLAC, M4A | 24-Bit / 192kHz | ❌ No | Extrae fuentes públicas de Amazon Music HD usando resolutores SongLink / Songstats. |
| **`qobuz`** | Nativo | FLAC | 24-Bit / 192kHz | ❌ No | Proveedor nativo de repuesto para Qobuz Studio Master. |
| **`tidal`** | Nativo | FLAC, M4A | 16-Bit Lossless | ❌ No | Proveedor nativo de repuesto para Tidal FLAC. |
| **`deezer`** | Nativo | FLAC | 16-Bit / 44.1kHz | ❌ No | Catálogo global Lossless (CD Quality). |
| **`youtube`** | Nativo | MP3, M4A, WebM | 320 kbps MP3 | ❌ No | **Proveedor de Último Recurso**. Cobertura del 100% para canciones indie o remixes no oficiales. |

---

## 🎯 Lista Prioritaria Recomendada (`services`)

Al enviar un JSON en `POST /api/v1/downloads`, el parámetro `services` determina el **orden exacto de prioridad** en que el servidor intentará descargar la canción.

### 🏆 Lista Sugerida para Máxima Calidad Lossless:
```json
"services": [
  "ext:tidal-web",
  "ext:qobuz-web",
  "amazon",
  "qobuz",
  "deezer",
  "youtube"
]
```

### ⚡ Lista Sugerida para Máxima Calidad 24-Bit Studio Master:
```json
"services": [
  "ext:qobuz-web",
  "qobuz",
  "ext:tidal-web",
  "amazon"
]
```

---

## 🧩 Gestión de Extensiones vía API REST

### 1. Listar Extensiones Instaladas
```bash
curl -X GET "http://localhost:8080/api/v1/extensions/installed"
```

### 2. Sincronizar y Actualizar Extensiones desde GitHub
```bash
curl -X POST "http://localhost:8080/api/v1/extensions/sync"
```

### 3. Instalar Extensión Personalizada por URL
```bash
curl -X POST "http://localhost:8080/api/v1/extensions/install" \
     -H "Content-Type: application/json" \
     -d '{"download_url_or_id": "https://midominio.com/extensiones/mi-extension.sflx"}'
```

### 4. Consultar y Modificar Configuración de una Extensión
```bash
# Obtener configuración actual
curl -X GET "http://localhost:8080/api/v1/extensions/qobuz-web/settings"

# Modificar valores
curl -X PUT "http://localhost:8080/api/v1/extensions/qobuz-web/settings" \
     -H "Content-Type: application/json" \
     -d '{"settings": {"countryCode": "US"}}'
```
