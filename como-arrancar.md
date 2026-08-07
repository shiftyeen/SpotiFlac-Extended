python server.py --host 0.0.0.0 --port 8000

Se ha actualizado [`server.py`](file:///c:/Users/oscar/Desktop/spotiflac-extended/server.py) para que imprima automáticamente en la consola de tu VPS la **IP pública real y los enlaces de acceso directo** cada vez que el servidor inicie.

Existen **3 formas principales** para acceder a tu servidor en el VPS:

---

### 1. 🚀 **Acceso Directo por la IP Pública de tu VPS (La Opción Más Rápida)**

Si tu VPS tiene una IP pública (por ejemplo `164.92.120.45` en DigitalOcean, AWS, Linode, Hetzner, etc.):

1. Al ejecutar en tu VPS:
   ```bash
   python server.py --host 0.0.0.0 --port 8080
   ```
2. La consola te mostrará tus enlaces de acceso inmediato:
   - 🎨 **Interfaz Web**: `http://<TU_IP_VPS>:8080/`
   - 📖 **Documentación API / Swagger**: `http://<TU_IP_VPS>:8080/docs`

> ⚠️ **Nota importante**: Asegúrate de abrir el puerto 8000 en el firewall de tu VPS Linux ejecutando:
> ```bash
> sudo ufw allow 8080/tcp
> ```

---

### 2. 🔒 **Acceso Seguro con HTTPS y Dominio Propio (Recomendado con Caddy)**

Si tienes un dominio o subdominio apuntando a la IP de tu VPS (por ejemplo `spotiflac.tudominio.com`):

1. Instala Caddy en tu VPS:
   ```bash
   sudo apt install -y caddy
   ```
2. Edita `/etc/caddy/Caddyfile` y agrega estas 3 líneas:
   ```caddy
   spotiflac.tudominio.com {
       reverse_proxy localhost:8080
   }
   ```
3. Reinicia Caddy: `sudo systemctl restart caddy`
4. Caddy genera **automáticamente un certificado SSL gratuito con HTTPS**:
   - 🎨 **Interfaz Web**: `https://spotiflac.tudominio.com/`
   - 📖 **Documentación API**: `https://spotiflac.tudominio.com/docs`

---

### 3. ⚡ **Link Público Temporal con `pinggy` (Sin Configurar Firewall)**

Si deseas obtener una URL pública sin abrir puertos ni configurar firewall:

1. Ejecuta este comando directamente en el terminal de tu VPS:
   ```bash
   ssh -R 80:localhost:8080 ssh.pinggy.io
   ```
2. El terminal te imprimirá un enlace público seguro `https://xxxx.pinggy.link` listo para abrir desde cualquier dispositivo.