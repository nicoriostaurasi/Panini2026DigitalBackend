# Panini 2026 Sync Backend

Backend local para conectar el plugin con el Manager.

## Correr local

```bash
npm start
```

Por defecto escucha en:

```text
http://localhost:8787
```

Para exponerlo con ngrok:

```bash
ngrok http 8787
```

Despues pega la URL HTTPS de ngrok en el plugin y en el Manager.

## Endpoints

- `GET /health`: prueba rapida.
- `GET /api/profiles`: lista estados sincronizados.
- `GET /api/profiles/:id`: obtiene un estado.
- `POST /api/profiles`: crea o actualiza un estado.

El archivo de datos se guarda en `data/profiles.json`.
