# Feeds para Meta (Grupo EFE)

Genera las piezas del catálogo completo y el CSV para Meta, según el horario de cada feed (hora de Lima),
y los sube por FTP al hosting. Lo corre GitHub Actions: `.github/workflows/feeds.yml` (revisión cada hora).

- Una receta por feed en `auto/recetas/<tienda>/<nombre>.json` (se crean y programan desde el panel «Mis feeds» de la Fábrica).
- El feed queda en `<FTP_URL>/<tienda>/<nombre>/feed.csv`; esa es la URL que se da de alta en Meta (no cambia aunque se regenere).
- Cada receta trae su propio horario (`horas`, HH:MM de Lima) y se puede pausar (`activo: false`) desde el panel, sin tocar este repo a mano.
- Solo se dibujan las piezas que cambiaron; las imágenes viejas se borran 48 h después de dejar de usarse.
- Si el catálogo cae a menos de la mitad de golpe, no se publica (receta con `"permitir_caida": true` para forzarlo una vez).

Secretos del repo (Settings > Secrets and variables > Actions): `FTP_HOST`, `FTP_USER`, `FTP_PASS`,
`FTP_DIR`, `FTP_URL` y, si hace falta, `FTP_TLS` (si | no) y `FTP_INSEGURO` (1).
Nunca se escriben en un archivo del repo.

## Lotes grandes (piezas para descargar, no para Meta)

`.github/workflows/lotes.yml`, a mano desde Actions > **Lote grande** > Run workflow.

- El pedido se encarga desde la Fábrica (bloque «Generar lote» > «Encargar a GitHub»); queda en `auto/pedidos/<id>.json` y viaja en este repo.
- Se reparte en varias partes (máximo 20) que corren a la vez; cada una deja su carpeta como **artefacto** de la corrida, ya en ZIP.
- No usa FTP ni secretos: nada sale del repo.
- Por qué acá: la conexión de la oficina da ~1 Mbps y bajar las fotos del catálogo se lleva la mayor parte del tiempo.
