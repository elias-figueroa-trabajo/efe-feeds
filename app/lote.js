// Lote grande sin pantalla. Lo corre GitHub Actions (auto/lotes.yml), una parte por job:
//   node app/lote.js <id> --parte K --de N [--plazo MIN] [--limite N]
// Levanta el servidor de la Fábrica en otro puerto, abre lote.html en Chrome sin pantalla y espera
// su fin.json. Las piezas quedan en publicado/_lotes/<id>/parte<K>/<formato>/*.jpg + manifiesto.
// No sube nada: el workflow toma esa carpeta con actions/upload-artifact y GitHub la entrega en ZIP.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { archivoPedido, dirParte, ID } = require('./lotes.js');

const ESPERA_MAX = 5 * 3600e3; // red de seguridad: la página deja de dibujar antes (--plazo)
const CI = !!process.env.GITHUB_ACTIONS;

const arg = process.argv.slice(2);
const CON_VALOR = ['--parte', '--de', '--plazo', '--limite', '--puerto', '--hilos'];
const opcion = n => { const i = arg.indexOf(n); return i >= 0 ? arg[i + 1] : undefined; };
const PARTE = Number(opcion('--parte')) || 0;
const DE = Number(opcion('--de')) || 1;
const LIMITE = Number(opcion('--limite')) || 0;
const HILOS = Number(opcion('--hilos')) || 0;
const PUERTO = Number(opcion('--puerto')) || 5191;
// Minutos para dibujar. Actions corta a las 6 h: lo que no alcance queda anotado como pendiente
// y el artefacto sale igual, con lo que sí se dibujó.
const PLAZO_MIN = Number(opcion('--plazo')) || 300;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const hora = () => new Date().toISOString().slice(11, 19);
const decir = t => console.log(`${hora()} ${t}`);

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

async function levantarServidor() {
  const env = { ...process.env, PORT: String(PUERTO), FEEDS_AUTO: 'no' }; // el runner no baja los feeds del día
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.stdout.on('data', d => process.stdout.write(String(d).replace(/^(?=.)/gm, '  ')));
  srv.stderr.on('data', d => process.stderr.write(String(d).replace(/^(?=.)/gm, '  ! ')));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PUERTO}/lote/lista`)).ok) return srv; } catch { /* aún no */ }
    if (srv.exitCode != null) break;
    await dormir(200);
  }
  srv.kill();
  throw new Error('El servidor local no arrancó en el puerto ' + PUERTO);
}

async function dibujar(id) {
  const d = dirParte(id, PARTE), fin = path.join(d, 'fin.json');
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'efe-lote-'));
  const url = `http://127.0.0.1:${PUERTO}/lote.html?id=${encodeURIComponent(id)}&parte=${PARTE}&de=${DE}`
    + `&plazo=${Date.now() + PLAZO_MIN * 60e3}${LIMITE ? '&limite=' + LIMITE : ''}${HILOS ? '&hilos=' + HILOS : ''}`;
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + perfil];
  if (CI) flags.push('--no-sandbox', '--disable-dev-shm-usage');
  const nav = spawn(buscarChrome(), [...flags, url], { stdio: 'ignore', windowsHide: true });
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

async function main() {
  const id = arg.find((a, i) => !a.startsWith('--') && !CON_VALOR.includes(arg[i - 1]));
  if (!id || !ID.test(id)) throw new Error('Uso: node app/lote.js <id> --parte K --de N');
  if (!fs.existsSync(archivoPedido(id))) throw new Error(`No hay pedido auto/pedidos/${id}.json`);
  const pedido = leerJson(archivoPedido(id), null);
  if (!pedido) throw new Error('El pedido no se puede leer');
  if (!(PARTE >= 0 && PARTE < DE && DE >= 1 && DE <= 20)) throw new Error('--parte debe ir de 0 a --de menos 1');

  const d = dirParte(id, PARTE);
  fs.rmSync(d, { recursive: true, force: true }); // cada corrida parte limpia
  fs.mkdirSync(d, { recursive: true });

  decir(`Pedido ${id} · campaña ${pedido.campaign_id} · formatos ${pedido.formatos.join(', ')} · parte ${PARTE + 1} de ${DE}`);
  const t0 = Date.now();
  const srv = await levantarServidor();
  let r;
  try { r = await dibujar(id); } finally { srv.kill(); }
  if (!r.ok) throw new Error(r.error);

  const min = (Date.now() - t0) / 60e3;
  decir(`Listo en ${min.toFixed(1)} min: ${r.piezas} piezas de ${r.productos} productos`
    + `${r.sinFoto ? `, ${r.sinFoto} sin foto` : ''}${r.pendientes ? `, ${r.pendientes} pendientes por plazo` : ''}`);

  const fila = `| ${PARTE + 1} de ${DE} | ${r.productos} | ${r.piezas} | ${r.sinFoto || 0} | ${r.pendientes || 0} | ${min.toFixed(1)} min |`;
  const resumen = ['| Parte | Productos | Piezas | Sin foto | Pendientes | Tiempo |', '|---|---|---|---|---|---|', fila].join('\n');
  console.log('\n' + resumen);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Lote ${id}\n\n${resumen}\n`);
  if (r.pendientes) console.log(`\nAviso: ${r.pendientes} piezas no alcanzaron el plazo de ${PLAZO_MIN} min. Vuelve a lanzar el lote con más partes.`);
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
