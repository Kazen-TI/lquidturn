# LiquidTurn — Sistema de turnos de liquidación Kazen

Aplicación web sencilla para que los vendedores tomen turno cuando vienen a liquidar gastos, y el liquidador los atienda en orden desde un panel.

## Características

- Registro del vendedor con celular, ruta y nombre
- Pantalla de espera en tiempo real (muestra cuántas personas hay adelante)
- Notificación visual y sonora cuando es su turno
- Panel administrativo del liquidador con métricas y botones "Llamar siguiente" / "Terminar"
- Actualización instantánea entre pantallas usando Server-Sent Events (SSE)
- Persistencia en archivo JSON local (`data/liquidturn.json`) — sin dependencias nativas, sin compilación

## Cómo correrlo localmente

```bash
npm install
npm start
```

Abrir:
- `http://localhost:3000/` → vendedor toma turno
- `http://localhost:3000/turno.html?id=<TICKET_ID>` → pantalla de espera (se redirige sola)
- `http://localhost:3000/admin.html` → panel del liquidador (PIN por defecto: `1234`)

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor |
| `ADMIN_PIN` | `1234` | PIN para acceder al panel del liquidador |

## Despliegue en Railway

1. Sube este folder a un repo de GitHub.
2. En [railway.app](https://railway.app) → New Project → Deploy from GitHub.
3. Railway detecta Node y corre `npm install && npm start` automáticamente.
4. En el dashboard del proyecto, agrega un **Volume** montado en `/data` para persistir la base de datos entre despliegues.
5. En Variables agrega `ADMIN_PIN` con un valor seguro.
6. Railway te da una URL pública (ej. `liquidturn-production.up.railway.app`). Compártela con los vendedores.

## Notas técnicas

- La base de datos se crea automáticamente en el primer arranque.
- Los turnos se reinician cada día (numeración 1, 2, 3...) — esto se hace al consultar el siguiente turno cuando cambia la fecha.
- Para integrar SMS real en el futuro, agrega un cliente Twilio en `server.js` dentro del handler `POST /api/queue/next`, donde se identifica al ticket que pasa a "atendiendo".
