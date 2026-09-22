// Lote grande sin pantalla: lo mismo que el botón «Generar lote» de la Fábrica, pero con el catálogo
// completo y repartido en partes (la abre app/lote.js, que a su vez corre en GitHub Actions).
// Cada parte se queda con los productos cuyo número de orden le toca (i % de === parte), dibuja todos
// los formatos del pedido y le pasa cada pieza al servidor local. El ZIP no se arma acá: la parte sube
// su carpeta como artefacto de Actions y GitHub la entrega ya comprimida.
import { FORMATOS } from './config.js';
import { leerFeed } from './feeds.js';
import { renderPng, cargarImg } from './lienzo.js';

const params = new URLSearchParams(location.search);
const id = params.get('id') || '', parte = Number(params.get('parte')) || 0, de = Number(params.get('de')) || 1;
const limite = Number(params.get('limite')) || 0;  // solo para pruebas: corta el feed a N productos
const HILOS = Number(params.get('hilos')) || 6;
// Hora tope para dibujar (la pone lote.js): lo que no alcance queda anotado como pendiente.
const plazo = Number(params.get('plazo')) || Infinity;
const q = `?id=${encodeURIComponent(id)}&parte=${parte}`;
const AVISO_CADA = 250;

const log = t => { document.getElementById('log').textContent += '\n' + t; };
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function pedir(ruta, opt) {
  const r = await fetch(ruta, opt), d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}
const progreso = t => { log(t); return fetch('/lote/progreso' + q, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: t }).catch(() => {}); };

let cortado = false;
function cortar(e) {
  if (cortado) return; cortado = true;
  const error = String(e?.message || e || 'error desconocido');
  log('ERROR: ' + error);
  fetch('/lote/fin' + q, json({ error })).catch(() => {});
}
window.onerror = (m, f, l) => cortar(`${m} (${f}:${l})`);
window.onunhandledrejection = e => cortar(e.reason);

const limpio = s => String(s).replace(/[^\w.-]+/g, '-');

async function correr() {
  const { pedido } = await pedir('/lote/pedido?id=' + encodeURIComponent(id));
  const fmts = pedido.formatos.map(x => FORMATOS.find(f => f.id === x)).filter(Boolean);
  if (!fmts.length) throw new Error('El pedido no trae formatos conocidos');
  const ext = pedido.tipo === 'image/png' ? 'png' : 'jpg';

  await progreso(`Leyendo el feed ${pedido.feed_url}`);
  let prods;
  try { prods = await leerFeed(pedido.feed_url); }
  catch (e) { // la tienda a veces tarda o corta: un segundo intento antes de rendirse
    await progreso(`El feed falló (${e.message}); reintento en 60 s`);
    await new Promise(r => setTimeout(r, 60000));
    prods = await leerFeed(pedido.feed_url);
  }
  if (pedido.skus && pedido.skus.length) {
    const quiero = new Set(pedido.skus.map(String));
    prods = prods.filter(p => quiero.has(String(p.sku)));
  }
  if (limite) prods = prods.slice(0, limite);
  await progreso(`${prods.length} productos en el feed`);

  // El reparto es por número de orden, no por bloques: así todas las partes tardan parecido aunque
  // el feed venga ordenado por categoría (fotos livianas al principio y pesadas al final, por ejemplo).
  const mios = prods.filter((_, i) => i % de === parte);
  await progreso(`Parte ${parte + 1} de ${de}: ${mios.length} productos × ${fmts.length} formatos = ${mios.length * fmts.length} piezas`);
  if (!mios.length) return pedir('/lote/fin' + q, json({ filas: [], productos: 0 }));

  const filas = [], usados = new Set();
  let i = 0, hechas = 0, sinFoto = 0, pendientes = 0;
  const total = mios.length * fmts.length;

  // Adelanto de fotos: se piden las de los próximos productos sin esperarlas, para que la descarga
  // corra mientras se dibuja (`cargarImg` deja la promesa en su caché). Con varios hilos ya hay
  // solapamiento, así que se queda corto a propósito.
  const ADELANTO = 4;

  async function hilo() {
    while (!cortado && i < mios.length) {
      const n = i++, p = mios[n];
      for (let k = n + 1; k < Math.min(n + 1 + ADELANTO, mios.length); k++) cargarImg(mios[k].image);
      if (Date.now() > plazo) { pendientes += fmts.length; hechas += fmts.length; continue; }
      for (const f of fmts) {
        const { blob, sinFoto: sf } = await renderPng(pedido.plantilla, f, p, pedido.tipo);
        const base = `${f.id}/${pedido.campaign_id}__${limpio(p.sku)}__${f.id}`;
        let nombre = `${base}.${ext}`;
        for (let k = 2; usados.has(nombre); k++) nombre = `${base}_${k}.${ext}`; // el mismo SKU dos veces en el feed
        usados.add(nombre);
        await pedir(`/lote/img${q}&archivo=${encodeURIComponent(nombre)}`, { method: 'POST', headers: { 'Content-Type': pedido.tipo }, body: blob });
        filas.push({ campaign_id: pedido.campaign_id, sku: p.sku, formato: f.id, archivo: nombre, titulo: p.title,
          precio: p.price?.v ?? '', precio_antes: p.oldPrice?.v ?? '', link: p.link, sin_foto: sf ? 'si' : '' });
        if (sf) sinFoto++;
        if (++hechas % AVISO_CADA === 0) progreso(`${hechas} de ${total} piezas`);
      }
    }
  }
  await Promise.all(Array.from({ length: HILOS }, hilo));
  if (cortado) return;

  await progreso(`Escribiendo el manifiesto: ${filas.length} piezas${sinFoto ? `, ${sinFoto} sin foto` : ''}${pendientes ? `, ${pendientes} pendientes por plazo` : ''}`);
  const r = await pedir('/lote/fin' + q, json({ filas, productos: mios.length, sinFoto, pendientes }));
  log('LISTO ' + JSON.stringify(r));
}
correr().catch(cortar);
