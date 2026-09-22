// Feed para Meta automático, sin pantalla. Lo corre GitHub Actions dos veces al día (auto/feeds.yml),
// y se puede correr a mano:  node app/auto.js <slug|--todas> [--sin-subir] [--limite N]
// Por cada receta (auto/recetas/<slug>.json):
//   1. baja <slug>/estado.json del FTP (qué piezas ya están arriba),
//   2. abre auto.html en Chrome/Edge sin pantalla: dibuja solo lo que cambió y escribe el CSV,
//   3. sube por FTP en este orden, para que Meta nunca vea un CSV que apunte a una imagen que falta:
//      imágenes nuevas → prueba HTTP de una → feed.csv (vía .tmp + renombrar) → estado.json → borra lo retirado hace más de 48 h.
// Configuración: variables de entorno (en Actions, secretos) o <proyecto>/publicar.env; manda el entorno.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ftp = require('./ftp');

const RAIZ = path.join(__dirname, '..');
const RECETAS = path.join(RAIZ, 'auto', 'recetas');
const AUTO = path.join(RAIZ, 'publicado', '_auto');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const ESPERA_MAX = 5 * 3600e3;     // red de seguridad: la página deja de dibujar antes (PLAZO_MIN)
const GRACIA = 48 * 3600e3;        // una imagen retirada se borra del hosting recién a las 48 h
const CI = !!process.env.GITHUB_ACTIONS;

const arg = process.argv.slice(2);
const opcion = n => { const i = arg.indexOf(n); return i >= 0 ? arg[i + 1] : undefined; };
const SUBIR = !arg.includes('--sin-subir');
const LIMITE = Number(opcion('--limite')) || 0;
const PUERTO = Number(opcion('--puerto')) || 5190;
// Minutos para dibujar. Actions corta a las 6 h y todavía hay que subir: lo que no alcance queda para la próxima.
const PLAZO_MIN = Number(opcion('--plazo')) || 210;

function variables() {
  const v = {};
  const archivo = process.env.PUBLICAR_ENV || path.join(RAIZ, 'publicar.env');
  try {
    for (const l of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin archivo: todo viene del entorno */ }
  for (const k of Object.keys(process.env)) if (/^FTP_/.test(k) && process.env[k]) v[k] = process.env[k];
  return v;
}

function buscarChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const win = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  if (process.platform === 'win32') { const f = win.find(x => fs.existsSync(x)); if (f) return f; }
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [n], { encoding: 'utf8' }).trim(); } catch { /* sigue */ }
  }
  throw new Error('No se encontró Chrome ni Edge (se puede indicar con la variable CHROME)');
}

const dormir = ms => new Promise(r => setTimeout(r, ms));
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const hora = () => new Date().toISOString().slice(11, 19);
const decir = (slug, t) => console.log(`${hora()} [${slug}] ${t}`);

// ---------- servidor local (el mismo de la Fábrica, en otro puerto) ----------
async function levantarServidor(v) {
  const env = { ...process.env, PORT: String(PUERTO), FEEDS_AUTO: 'no' }; // el runner no baja los feeds del día
  if (v.FTP_URL) env.FTP_URL = v.FTP_URL;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.stdout.on('data', d => process.stdout.write(String(d).replace(/^(?=.)/gm, '  ')));
  srv.stderr.on('data', d => process.stderr.write(String(d).replace(/^(?=.)/gm, '  ! ')));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PUERTO}/publicar/estado`)).ok) return srv; } catch { /* aún no */ }
    if (srv.exitCode != null) break;
    await dormir(200);
  }
  srv.kill();
  throw new Error('El servidor local no arrancó en el puerto ' + PUERTO);
}

// ---------- una receta ----------
async function dibujar(slug, chrome) {
  const d = path.join(AUTO, slug), fin = path.join(d, 'fin.json');
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'efe-auto-'));
  const url = `http://127.0.0.1:${PUERTO}/auto.html?slug=${encodeURIComponent(slug)}&plazo=${Date.now() + PLAZO_MIN * 60e3}${LIMITE ? '&limite=' + LIMITE : ''}`;
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + perfil];
  if (CI) flags.push('--no-sandbox', '--disable-dev-shm-usage');
  const nav = spawn(chrome, [...flags, url], { stdio: 'ignore', windowsHide: true });
  let salio = false; nav.on('exit', () => { salio = true; });
  try {
    const t0 = Date.now();
    while (!fs.existsSync(fin)) {
      if (salio) throw new Error('El navegador se cerró antes de terminar');
      if (Date.now() - t0 > ESPERA_MAX) throw new Error('Pasaron 5 h sin terminar');
      await dormir(2000);
    }
    await dormir(300); // que termine de escribirse
    return leerJson(fin, { ok: false, error: 'fin.json ilegible' });
  } finally {
    nav.kill();
    await dormir(500);
    fs.rmSync(perfil, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function correrReceta(slug, chrome, c) {
  const d = path.join(AUTO, slug), img = path.join(d, 'img');
  // Cada corrida parte limpia: img/ solo tendrá lo dibujado ahora.
  fs.rmSync(img, { recursive: true, force: true });
  for (const f of ['feed.csv', 'estado.nuevo.json', 'fin.json']) fs.rmSync(path.join(d, f), { force: true });
  fs.mkdirSync(img, { recursive: true });
  if (c) {
    fs.rmSync(path.join(d, 'estado.json'), { force: true });
    const hay = await ftp.bajar(c, `${slug}/estado.json`, path.join(d, 'estado.json'));
    if (hay) { // un estado roto no se toma como «primera vez»: se perdería el freno contra caídas
      const e = leerJson(path.join(d, 'estado.json'), null);
      if (!e || typeof e.productos !== 'object' || typeof e.retirados !== 'object') throw new Error('estado.json del hosting está dañado; revísalo antes de seguir');
    }
    decir(slug, hay ? 'Estado del hosting leído' : 'Primera vez en el hosting: se dibuja todo');
  }

  const t0 = Date.now();
  const r = await dibujar(slug, chrome);
  if (!r.ok) throw new Error(r.error);
  decir(slug, `Dibujo listo en ${Math.round((Date.now() - t0) / 60e3)} min: ${r.productos} productos, ${r.nuevas} piezas nuevas, ${r.reusadas} reusadas${r.atrasadas ? ` (${r.atrasadas} con el diseño anterior)` : ''}${r.fuera && r.fuera.pendientes ? `, ${r.fuera.pendientes} pendientes para la próxima corrida` : ''}. Fuera: ${JSON.stringify(r.fuera || {})}`);

  const estado = leerJson(path.join(d, 'estado.nuevo.json'), null);
  if (!estado) throw new Error('No se escribió estado.nuevo.json');
  const ahora = Date.now();
  const vencidos = Object.entries(estado.retirados).filter(([, f]) => ahora - Date.parse(f) > GRACIA).map(([a]) => a);
  let borradas = 0;

  // El estado sale sin los vencidos ANTES de borrarlos: si el borrado falla quedan huérfanos (no molesta);
  // al revés, un estado viejo los daría por existentes y se reusaría una imagen ya borrada.
  for (const a of vencidos) delete estado.retirados[a];
  fs.writeFileSync(path.join(d, 'estado.json'), JSON.stringify(estado));
  const http = async rel => { try { return (await fetch(`${c.url}/${rel}`, { method: 'HEAD' })).status; } catch (e) { return e.message; } };
  let visible = '';
  if (c) {
    const nuevas = fs.readdirSync(img).map(f => [path.join(img, f), `${slug}/img/${f}`]);
    await ftp.subir(c, nuevas, (n, t) => { if (n % 500 === 0 || n === t) decir(slug, `Subidas ${n} de ${t} imágenes`); });
    // FTP bien no garantiza que se vea por la web (FTP_DIR y FTP_URL que no calzan, permisos): se prueba una antes del CSV.
    if (nuevas.length) {
      const s = await http(nuevas[0][1]);
      if (s !== 200) throw new Error(`La imagen subida no se ve en ${c.url}/${nuevas[0][1]} (HTTP ${s}); revisa FTP_DIR y FTP_URL. No se publicó el CSV`);
    }
    await ftp.subirAtomico(c, path.join(d, 'feed.csv'), `${slug}/feed.csv`);
    decir(slug, 'CSV publicado');
    await ftp.subirAtomico(c, path.join(d, 'estado.json'), `${slug}/estado.json`);
    if (vencidos.length) await ftp.borrar(c, vencidos.map(a => `${slug}/img/${a}`));
    visible = await http(`${slug}/feed.csv`);
  }
  borradas = vencidos.length; // en prueba local se simula el borrado
  fs.rmSync(path.join(d, 'estado.nuevo.json'), { force: true });
  if (c && visible !== 200) throw new Error(`El CSV se subió pero la web responde ${visible} en ${c.url}/${slug}/feed.csv`);
  return { ...r, borradas, en_espera: Object.keys(estado.retirados).length, visible };
}

async function main() {
  const todas = fs.existsSync(RECETAS) ? fs.readdirSync(RECETAS).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(s => SLUG.test(s)) : [];
  const pedidas = arg.includes('--todas') ? todas : arg.filter((a, i) => !a.startsWith('--') && !['--limite', '--puerto', '--plazo'].includes(arg[i - 1]));
  if (!pedidas.length) throw new Error('Uso: node app/auto.js <slug|--todas> [--sin-subir] [--limite N]. Recetas: ' + (todas.join(', ') || 'ninguna'));
  for (const s of pedidas) if (!todas.includes(s)) throw new Error('No hay receta ' + s + ' en auto/recetas/');

  const v = variables();
  let c = null;
  if (SUBIR) {
    // Con --limite el feed sale recortado y el freno de caídas no lo ve en la primera corrida:
    // solo con --sin-subir o contra un FTP de prueba en esta máquina.
    if (LIMITE && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(v.FTP_URL || '')) throw new Error('--limite es solo para pruebas: úsalo con --sin-subir');
    c = ftp.ftpConfig(v);
    c.url = String(v.FTP_URL || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(c.url)) throw new Error('Falta FTP_URL: la dirección pública de la carpeta FTP_DIR');
  } else if (!v.FTP_URL) v.FTP_URL = 'https://ejemplo.invalid/feeds'; // prueba local: el CSV igual necesita una base

  const chrome = buscarChrome();
  console.log(`Navegador: ${chrome}\n${SUBIR ? 'Sube por FTP a ' + c.host + '/' + c.dir : 'Prueba local: no sube nada'}`);
  const srv = await levantarServidor(v);
  const filas = [];
  let fallas = 0;
  try {
    for (const slug of pedidas) {
      try {
        const r = await correrReceta(slug, chrome, c);
        filas.push(`| ${slug} | ok | ${r.productos} | ${r.nuevas} | ${r.reusadas} | ${(r.fuera && r.fuera.pendientes) || 0} | ${r.borradas} | ${r.visible || '-'} |`);
        decir(slug, 'Listo ' + JSON.stringify(r));
      } catch (e) {
        fallas++;
        filas.push(`| ${slug} | **falló**: ${String(e.message).replace(/\|/g, '/').slice(0, 300)} | | | | | | |`);
        decir(slug, 'FALLÓ: ' + e.message);
      }
    }
  } finally { srv.kill(); }

  const resumen = ['| Feed | Resultado | Productos | Nuevas | Reusadas | Pendientes | Borradas | HTTP del CSV |', '|---|---|---|---|---|---|---|---|', ...filas].join('\n');
  console.log('\n' + resumen);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Feeds para Meta\n\n' + resumen + '\n');
  if (fallas) process.exitCode = 1;
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
