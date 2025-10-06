# api

## Rutas

- `POST /defi/viniswap/pairs/:pairAddress/sync`
  - Headers: `Authorization` (si tu middleware `auth` lo requiere).
  - Body JSON:
    - `startBlock` *(number, requerido)*: bloque desde el que recalcular.
    - `endBlock` *(number, opcional)*: bloque final; por defecto usa el último disponible.
    - `batchSize` *(number, opcional)*: tamaño de ventana en bloques para consultar logs (default `5000`).
    - `batchDelayMs` *(number, opcional)*: milisegundos a esperar entre ventanas (default `250`).
    - `maxRetries` *(number, opcional)*: reintentos por ventana ante rate limits/timeouts (default `5`).
    - `useBlockscout` *(boolean, opcional)*: usa la API externa para detectar eventos antes de pegarle al RPC (default `true`).
    - `blockscoutPageSize` *(number, opcional)*: tamaño de página por request a Blockscout/BaseScan (default `100`).
    - `blockscoutDelayMs` *(number, opcional)*: retardo entre páginas en la API externa (default `250`).
    - `verbose` *(boolean, opcional)*: si es `true`, imprime cada chunk procesado y cada evento encontrado (swaps, mints, burns, syncs y transfers) con fecha (`isoDate`) y reservas posteriores.
  - Comportamiento: lee eventos `Swap`, `Mint`, `Burn` y `Sync` del contrato LP de Viniswap directamente desde la blockchain, imprime el historial en consola (si `verbose`) y responde con un resumen de totales. Pensado para ejecutarse periódicamente vía cron.

### Ejemplo de ejecución en Base

> Prepara la variable `RPC_URL` apuntando a tu nodo (ej. `https://mainnet.base.org`).

```bash
curl -X POST \
  https://tu-api.com/defi/viniswap/pairs/0x2b1A955b2C8B49579d197eAaa7DcE7DBC7b4dA23/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "startBlock": 12000000,
    "batchSize": 500,
    "batchDelayMs": 400,
    "maxRetries": 8,
    "useBlockscout": true,
    "blockscoutPageSize": 200,
    "blockscoutDelayMs": 300,
    "verbose": true
  }'
```

Mientras el endpoint corre, verás en la consola del servidor mensajes por chunk y, al finalizar, un resumen con los conteos de eventos.

La respuesta JSON incluye:

- `events.swaps | mints | burns | syncs | transfers`: cada elemento trae `timestamp`, `isoDate`, datos del evento y `reservesAfter` (cuando aplica).
- Cada evento incluye `readableDate` (UTC) junto al `timestamp` en segundos.
- `summary.transferCount` con el total de transferencias de LP detectadas.

### Variables de entorno relacionadas

- `RPC_URL`: nodo RPC para Base (requerido).
- `BLOCKSCOUT_API_URL`: URL base de la API de Blockscout/Etherscan compatible (default `https://base.blockscout.com/api`).
- `BLOCKSCOUT_API_KEY`: API key opcional para el proveedor que uses.

## Scripts

- `npm run dev`
- `npm run build`
