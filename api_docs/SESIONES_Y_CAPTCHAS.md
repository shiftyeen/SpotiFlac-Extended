# 🔒 Verificación de Sesiones, Cloudflare Turnstile y Captchas

Las extensiones `ext:tidal-web` y `ext:qobuz-web` utilizan la infraestructura de la API Zarz (`api.zarz.moe/v2`) protegida por la firma criptográfica **ZARZ-HMAC-V1** y **Cloudflare Turnstile**.

Esta guía explica cómo funciona la autenticación de sesiones, por qué se requiere verificación en VPS y cómo resolverla de forma automática o mediante la API.

---

## ⚡ 1. ¿Por qué aparece `verification_required` o "Network changed during verification"?

Cuando el servidor `SpotiFLAC` está hospedado en una VPS (ejemplo: en Chile) y la solicitud se realiza desde un cliente en otra ubicación geográfica (ejemplo: en México), Cloudflare Turnstile detecta un cambio de dirección IP entre la firma del desafío y el consumo del token.

### 🛑 Error en Respuesta API (`400 Bad Request` o `verification_required`):
```json
{
  "success": false,
  "error_message": "Cloudflare Turnstile verification required for namespace zarz-v2",
  "error_type": "verification_required",
  "verification_url": "http://<TU_IP_VPS>:8080/static/index.html?challenge=..."
}
```

---

## 🤖 2. Solución 1: Auto-Resolución Headless Servidor (Recomendado para VPS)

Puedes configurar tu VPS para que resuelva los captchas de Cloudflare Turnstile de forma **100% automática en segundo plano** sin intervención humana instalando Chromium y PyDoll en tu VPS Linux:

```bash
# 1. Instalar Chromium y ChromeDriver en la VPS
sudo apt update && sudo apt install -y chromium-browser chromium-chromedriver xvfb

# 2. Instalar el paquete PyDoll para Python
pip install pydoll-python
```

Una vez instalados estos paquetes en tu VPS, el motor [`SpotiFLAC/core/solver.py`](file:///c:/Users/oscar/Desktop/spotiflac-extended/SpotiFLAC/core/solver.py) detectará automáticamente Chromium y resolverá los desafíos Turnstile silenciosamente en headless.

---

## 🌐 3. Solución 2: Resolución Manual o por Callback API

Si prefieres resolver el captcha desde tu navegador o desde el bot:

### A) Vía Modal Pop-up en la Interfaz Web:
1. Al aparecer el aviso en la Web UI, haz clic en **"Verificar Cloudflare"**.
2. Completa el captcha en la ventana emergente.
3. El callback en la ruta `GET /api/v1/sessions/grant_callback` interceptará automáticamente la respuesta y reanudará la descarga en tu servidor.

### B) Vía Inyección de Grant REST API (`POST /api/v1/sessions/grant`):
Si tu bot captura el token de grant, puedes inyectarlo directamente al servidor:

```bash
curl -X POST "http://localhost:8080/api/v1/sessions/grant" \
     -H "Content-Type: application/json" \
     -d '{
       "namespace": "zarz-v2",
       "grant": "0.1A2B3C4D5E6F7G8H..."
     }'
```

- **Respuesta Exitosa (`200 OK`)**:
```json
{
  "message": "Sesión verificada y guardada correctamente",
  "authenticated": true
}
```
