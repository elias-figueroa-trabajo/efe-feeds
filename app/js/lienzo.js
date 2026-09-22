// Lienzo de la Fábrica: la plantilla, cómo se dibuja una pieza y el editor con arrastre.
// Las posiciones van en fracciones del lienzo (0 a 1) por formato, así una misma plantilla
// sirve para 1:1, 4:5, 9:16 y banner, y cada formato se puede acomodar por separado.
import { proxied } from './config.js';
import { fmtPrecio } from './feeds.js';

export const NOMBRES = { foto: 'Foto del producto', logo: 'Logo', sello: 'Sello', marca: 'Marca', titulo: 'Título', precio: 'Precio', texto: 'Texto libre' };

export function plantillaBase() {
  return {
    id: 'base', nombre: 'Base',
    fondo: { c1: '#c8102e', c2: '#4a0510', img: '' },
    orden: ['foto', 'logo', 'sello', 'marca', 'titulo', 'precio', 'texto'],
    capas: {
      foto: { vis: true, tarjeta: true, cTarjeta: '#ffffff' },
      logo: { vis: true, src: '' },
      sello: { vis: true, texto: 'OFERTA', bg: '#ffd400', color: '#1a1a1a' },
      marca: { vis: true, color: '#ffd9de', bold: false, align: 'left', mayus: true },
      titulo: { vis: true, color: '#ffffff', bold: true, align: 'left' },
      precio: { vis: true, color: '#ffffff', bg: '', align: 'left' },
      texto: { vis: false, texto: 'Solo por hoy', color: '#ffffff', bold: false, align: 'left' },
    },
    pos: {
      '1x1': { logo: [.06, .05, .3, .09], sello: [.66, .05, .28, .08], foto: [.08, .17, .84, .5], marca: [.08, .7, .84, .04], titulo: [.08, .745, .84, .11], precio: [.08, .865, .6, .1], texto: [.66, .88, .28, .06] },
      '4x5': { logo: [.06, .04, .3, .075], sello: [.66, .04, .28, .065], foto: [.08, .14, .84, .5], marca: [.08, .67, .84, .035], titulo: [.08, .71, .84, .11], precio: [.08, .835, .6, .1], texto: [.66, .86, .28, .05] },
      '9x16': { logo: [.08, .06, .36, .06], sello: [.6, .06, .32, .045], foto: [.08, .18, .84, .44], marca: [.08, .65, .84, .025], titulo: [.08, .685, .84, .09], precio: [.08, .79, .84, .08], texto: [.08, .88, .84, .04] },
      '3x1': { foto: [.03, .08, .28, .84], logo: [.35, .1, .2, .2], marca: [.35, .36, .4, .1], titulo: [.35, .48, .4, .3], precio: [.78, .34, .19, .3], sello: [.78, .1, .19, .18], texto: [.78, .7, .19, .15] },
    },
  };
}

// ---------- imágenes ----------
// Caché con tope: en un lote de miles de productos no se guardan todas las fotos a la vez.
// Los data:/blob: (logo y fondo subidos) no se desalojan.
const imgs = new Map(), TOPE_IMGS = 150;
export function cargarImg(src) {
  if (!src) return Promise.resolve(null);
  if (imgs.has(src)) { const p = imgs.get(src); imgs.delete(src); imgs.set(src, p); return p; } // la más usada va al final
  for (const k of imgs.keys()) { if (imgs.size < TOPE_IMGS) break; if (!/^(data|blob):/.test(k)) imgs.delete(k); }
  // Un corte de red no se guarda como «sin foto»: se reintenta una vez y el fallo no queda en caché.
  const una = () => new Promise(ok => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => ok(im);
    im.onerror = () => ok(null); // sin foto no se cae el lote: la pieza sale sin ella y se avisa
    im.src = proxied(src);
  });
  const p = una().then(im => im || new Promise(r => setTimeout(r, 700)).then(una)).then(im => { if (!im && imgs.get(src) === p) imgs.delete(src); return im; });
  imgs.set(src, p);
  return p;
}

// ---------- ayudas de dibujo ----------
function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const FUENTE = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

function partir(ctx, texto, ancho) {
  const lineas = []; let l = '';
  for (const p of texto.split(/\s+/)) {
    const prueba = l ? l + ' ' + p : p;
    if (ctx.measureText(prueba).width <= ancho || !l) l = prueba; else { lineas.push(l); l = p; }
  }
  if (l) lineas.push(l);
  return lineas;
}

// Busca el tamaño más grande que entra en la caja; si no entra ni al mínimo, corta con "…".
function encajar(ctx, texto, w, h, bold, maxLineas = 4) {
  for (let s = Math.floor(h * .9); s >= 10; s = Math.floor(s * .93)) {
    ctx.font = `${bold ? 700 : 400} ${s}px ${FUENTE}`;
    const ls = partir(ctx, texto, w);
    if (ls.length <= maxLineas && ls.length * s * 1.15 <= h && ls.every(x => ctx.measureText(x).width <= w)) return { s, ls };
  }
  const s = 10; ctx.font = `${bold ? 700 : 400} ${s}px ${FUENTE}`;
  const ls = partir(ctx, texto, w).slice(0, Math.max(1, Math.floor(h / (s * 1.15))));
  ls[ls.length - 1] += '…';
  return { s, ls };
}

function textoEnCaja(ctx, texto, [x, y, w, h], c) {
  if (!texto) return;
  const { s, ls } = encajar(ctx, texto, w, h, c.bold);
  ctx.fillStyle = c.color; ctx.textBaseline = 'top';
  ctx.textAlign = c.align || 'left';
  const ax = c.align === 'center' ? x + w / 2 : c.align === 'right' ? x + w : x;
  ls.forEach((l, i) => ctx.fillText(l, ax, y + i * s * 1.15));
}

function contener(ctx, im, x, y, w, h) {
  const k = Math.min(w / im.width, h / im.height), iw = im.width * k, ih = im.height * k;
  ctx.drawImage(im, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

// ---------- una pieza ----------
export async function dibujar(ctx, W, H, pl, fmt, prod, op = {}) {
  const [foto, logo, fondoImg] = await Promise.all([cargarImg(prod?.image), cargarImg(pl.capas.logo.src), cargarImg(pl.fondo.img)]);
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W * .4, H);
  g.addColorStop(0, pl.fondo.c1); g.addColorStop(1, pl.fondo.c2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (fondoImg) { const k = Math.max(W / fondoImg.width, H / fondoImg.height); ctx.drawImage(fondoImg, (W - fondoImg.width * k) / 2, (H - fondoImg.height * k) / 2, fondoImg.width * k, fondoImg.height * k); }

  const caja = id => { const p = pl.pos[fmt][id]; return [p[0] * W, p[1] * H, p[2] * W, p[3] * H]; };
  const r = Math.min(W, H) * .03;
  for (const id of pl.orden) {
    const c = pl.capas[id];
    if (!c.vis) continue;
    const [x, y, w, h] = caja(id);
    if (id === 'foto') {
      if (c.tarjeta) { ctx.fillStyle = c.cTarjeta; rrect(ctx, x, y, w, h, r); ctx.fill(); }
      const pad = c.tarjeta ? Math.min(w, h) * .06 : 0;
      if (foto) contener(ctx, foto, x + pad, y + pad, w - pad * 2, h - pad * 2);
      else if (op.editor) { ctx.fillStyle = '#0003'; ctx.font = `${h * .06}px ${FUENTE}`; ctx.textAlign = 'center'; ctx.fillText(prod ? 'Sin foto' : 'Elige un producto', x + w / 2, y + h / 2); }
    } else if (id === 'logo') {
      if (logo) contener(ctx, logo, x, y, w, h);
      else if (op.editor) { ctx.strokeStyle = '#fff8'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); textoEnCaja(ctx, 'Sube tu logo', [x + w * .1, y + h * .25, w * .8, h * .5], { color: '#fffa', align: 'center' }); }
    } else if (id === 'sello') {
      ctx.fillStyle = c.bg; rrect(ctx, x, y, w, h, h / 2); ctx.fill();
      textoEnCaja(ctx, c.texto, [x + h * .35, y + h * .18, w - h * .7, h * .64], { color: c.color, bold: true, align: 'center' });
    } else if (id === 'marca') {
      const t = prod?.brand || 'MARCA';
      textoEnCaja(ctx, c.mayus ? t.toUpperCase() : t, [x, y, w, h], c);
    } else if (id === 'titulo') {
      textoEnCaja(ctx, prod?.title || 'Título del producto', [x, y, w, h], c);
    } else if (id === 'precio') {
      if (c.bg) { ctx.fillStyle = c.bg; rrect(ctx, x, y, w, h, r); ctx.fill(); }
      const p = prod ? fmtPrecio(prod.price) : 'S/ 999';
      const pad = c.bg ? h * .12 : 0;
      if (prod?.oldPrice) {
        const antes = [x + pad, y + pad, w - pad * 2, (h - pad * 2) * .32];
        textoEnCaja(ctx, 'Antes ' + fmtPrecio(prod.oldPrice), antes, { color: c.color, align: c.align });
        textoEnCaja(ctx, p, [x + pad, y + pad + (h - pad * 2) * .34, w - pad * 2, (h - pad * 2) * .66], { color: c.color, bold: true, align: c.align });
      } else textoEnCaja(ctx, p, [x + pad, y + pad, w - pad * 2, h - pad * 2], { color: c.color, bold: true, align: c.align });
    } else if (id === 'texto') {
      textoEnCaja(ctx, c.texto, [x, y, w, h], c);
    }
  }

  if (op.sel && pl.capas[op.sel]?.vis) {
    const [x, y, w, h] = caja(op.sel), k = op.k || 1;
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2 * k; ctx.setLineDash([8 * k, 5 * k]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8'; ctx.fillRect(x + w - 9 * k, y + h - 9 * k, 18 * k, 18 * k);
  }
  ctx.restore();
  return { sinFoto: !!prod && !foto };
}

// ---------- editor ----------
// Arrastrar mueve la capa; la esquina inferior derecha la redimensiona; flechas la empujan.
export class Editor {
  constructor(canvas, { alCambiar, alElegir }) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.alCambiar = alCambiar; this.alElegir = alElegir;
    this.pl = null; this.fmt = null; this.prod = null; this.sel = null; this.turno = 0;
    canvas.addEventListener('pointerdown', e => this.bajar(e));
    canvas.addEventListener('pointermove', e => this.mover(e));
    canvas.addEventListener('pointerup', e => this.subir(e));
    canvas.addEventListener('pointercancel', e => this.subir(e));
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', e => this.tecla(e));
  }
  poner({ pl = this.pl, fmt = this.fmt, prod = this.prod } = {}) {
    this.pl = pl; this.prod = prod;
    if (fmt !== this.fmt) { this.fmt = fmt; this.cv.width = fmt.w; this.cv.height = fmt.h; }
    return this.pintar();
  }
  async pintar() {
    const t = ++this.turno, k = this.cv.width / this.cv.getBoundingClientRect().width || 1;
    const off = document.createElement('canvas'); off.width = this.cv.width; off.height = this.cv.height;
    const r = await dibujar(off.getContext('2d'), off.width, off.height, this.pl, this.fmt.id, this.prod, { editor: true, sel: this.sel, k });
    if (t === this.turno) { this.ctx.clearRect(0, 0, off.width, off.height); this.ctx.drawImage(off, 0, 0); }
    return r;
  }
  punto(e) { const b = this.cv.getBoundingClientRect(); return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]; }
  pos(id) { return this.pl.pos[this.fmt.id][id]; }
  bajar(e) {
    const [px, py] = this.punto(e), b = this.cv.getBoundingClientRect();
    const hx = 14 / b.width, hy = 14 / b.height;
    if (this.sel) { const [x, y, w, h] = this.pos(this.sel); if (Math.abs(px - (x + w)) < hx && Math.abs(py - (y + h)) < hy) { this.arr = { modo: 'tam', px, py, o: [...this.pos(this.sel)] }; this.cv.setPointerCapture(e.pointerId); return; } }
    const hit = [...this.pl.orden].reverse().find(id => { if (!this.pl.capas[id].vis) return false; const [x, y, w, h] = this.pos(id); return px >= x && px <= x + w && py >= y && py <= y + h; }) || null;
    this.elegir(hit);
    if (hit) { this.arr = { modo: 'mover', px, py, o: [...this.pos(hit)] }; this.cv.setPointerCapture(e.pointerId); }
  }
  mover(e) {
    const [px, py] = this.punto(e);
    if (!this.arr) {
      if (!this.sel) { this.cv.style.cursor = 'default'; return; }
      const [x, y, w, h] = this.pos(this.sel), b = this.cv.getBoundingClientRect();
      this.cv.style.cursor = Math.abs(px - (x + w)) < 14 / b.width && Math.abs(py - (y + h)) < 14 / b.height ? 'nwse-resize' : 'move';
      return;
    }
    const { modo, o } = this.arr, dx = px - this.arr.px, dy = py - this.arr.py, p = this.pos(this.sel);
    if (modo === 'mover') { p[0] = Math.min(Math.max(o[0] + dx, -o[2] * .5), 1 - o[2] * .5); p[1] = Math.min(Math.max(o[1] + dy, -o[3] * .5), 1 - o[3] * .5); }
    else { p[2] = Math.max(.03, o[2] + dx); p[3] = Math.max(.02, o[3] + dy); }
    this.pintar();
  }
  subir() { if (this.arr) { this.arr = null; this.alCambiar(); } }
  tecla(e) {
    if (!this.sel || !e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const p = this.pos(this.sel), d = e.shiftKey ? .01 : .002;
    if (e.key === 'ArrowLeft') p[0] -= d; if (e.key === 'ArrowRight') p[0] += d; if (e.key === 'ArrowUp') p[1] -= d; if (e.key === 'ArrowDown') p[1] += d;
    this.pintar(); this.alCambiar();
  }
  elegir(id) { this.sel = id; this.alElegir(id); this.pintar(); }
}

// Pieza final a tamaño real, sin marcas de edición.
// Exporta con `toDataURL` y no con `toBlob`: medido en Chrome (2026-09-22, 1080x1080 JPEG),
// `toBlob` tarda ~1020 ms por pieza y `toDataURL` ~20 ms con el mismo codificador y la misma
// calidad. El lienzo se dibuja en 5 ms, así que ese segundo era casi todo el costo de un lote
// (62.476 piezas = 17 h). Pasar el base64 a bytes a mano cuesta ~2 ms. Devuelve también `bytes`
// para que quien arma un ZIP no tenga que volver a leer el blob.
export async function renderPng(pl, fmt, prod, tipo = 'image/png') {
  const cv = document.createElement('canvas'); cv.width = fmt.w; cv.height = fmt.h;
  const r = await dibujar(cv.getContext('2d'), fmt.w, fmt.h, pl, fmt.id, prod);
  let du;
  try { du = cv.toDataURL(tipo, .9); } catch { throw new Error('el lienzo no se pudo exportar'); }
  if (!du || du.length < 100) throw new Error('el lienzo no se pudo exportar');
  const b64 = atob(du.slice(du.indexOf(',') + 1)), bytes = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
  return { blob: new Blob([bytes], { type: tipo }), bytes, sinFoto: r.sinFoto };
}
