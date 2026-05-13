# Panini 2026 Digital Backend

Backend local para conectar el plugin con el Manager.

## Correr local

```bash
npm start
```

Por defecto escucha en:

```text
http://localhost:8787
```

El mismo servidor tambien sirve el Manager si la carpeta `Panini2026DigitalManager` esta al lado de `Panini2026DigitalBackend`:

```text
http://localhost:8787/
```

Para exponerlo con ngrok:

```bash
ngrok http 8787
```

Despues pega la URL HTTPS de ngrok en el plugin y en el Manager.

## Raspberry Pi

La idea recomendada es correr un solo servicio Node en la Raspberry:

- Manager: `http://raspberry:8787/`
- API: `http://raspberry:8787/api/...`
- Health: `http://raspberry:8787/health`

El puerto interno de la app es `8787` por defecto. Si lo queres cambiar:

```bash
PORT=3000 npm start
```

Si el Manager esta en otra ubicacion, podes indicar la carpeta:

```bash
MANAGER_DIR=/home/pi/PaniniDigitalManager/Panini2026DigitalManager npm start
```

Para acceder desde afuera de tu casa no conviene abrir `8787` directo sin HTTPS. Lo mas simple es poner un tunel o proxy HTTPS delante:

- Cloudflare Tunnel: expone `https://panini.tudominio.com` hacia `http://localhost:8787`.
- ngrok: expone una URL HTTPS hacia `http://localhost:8787`.
- Nginx/Caddy: escucha en `443` y proxy_pass hacia `http://localhost:8787`.

El plugin debe apuntar a la URL publica HTTPS, por ejemplo:

```text
https://panini.tudominio.com
```

No tiene que pegarle a `:8787` si hay un dominio/proxy HTTPS adelante. El puerto expuesto publicamente deberia ser `443`; el `8787` queda interno en la Raspberry.

## Docker

Desde la carpeta raiz `PaniniDigitalManager`, donde estan `Panini2026DigitalBackend` y `Panini2026DigitalManager`:

```bash
docker compose up -d --build
```

La app queda disponible en:

```text
http://localhost:8787/
http://localhost:8787/health
```

En Raspberry seria:

```text
http://raspberrypi.local:8787/
```

Ver logs:

```bash
docker compose logs -f
```

Frenar:

```bash
docker compose down
```

Los datos quedan persistidos en el volumen Docker `paninidigitalmanager_panini-data`, montado en `/app/backend/data`. Para borrar tambien los datos:

```bash
docker compose down -v
```

Si lo expones con Cloudflare Tunnel, ngrok, Caddy o Nginx, apunta el proxy/tunel a:

```text
http://localhost:8787
```

### Servicio systemd de ejemplo

Crear `/etc/systemd/system/panini-digital.service`:

```ini
[Unit]
Description=Panini Digital Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/pi/PaniniDigitalManager/Panini2026DigitalBackend
Environment=PORT=8787
Environment=MANAGER_DIR=/home/pi/PaniniDigitalManager/Panini2026DigitalManager
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=pi

[Install]
WantedBy=multi-user.target
```

Activarlo:

```bash
sudo systemctl daemon-reload
sudo systemctl enable panini-digital
sudo systemctl start panini-digital
sudo journalctl -u panini-digital -f
```

## Endpoints

- `GET /health`: prueba rapida.
- `POST /api/auth/register`: crea usuario. Requiere `username` y `password`.
- `POST /api/auth/login`: inicia sesion.
- `GET /api/me`: obtiene el usuario logueado.
- `GET /api/profiles`: lista estados sincronizados.
- `GET /api/profiles/:id`: obtiene un estado.
- `POST /api/profiles`: crea o actualiza un estado.
- `GET /api/users?q=nombre`: busca usuarios para comparar.
- `GET /api/users/:username/profile`: obtiene el progreso sincronizado de un usuario.

El archivo de datos se guarda en `data/profiles.json`.
