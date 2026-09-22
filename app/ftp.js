// FTP con curl (viene con Windows 10+ y con Linux): sin dependencias.
// Configuración por variables (en GitHub Actions son secretos; en local, publicar.env):
//   FTP_HOST, FTP_USER, FTP_PASS, FTP_DIR (carpeta desde el inicio de la cuenta, ej. public_html/feeds),
//   FTP_TLS = si (exige cifrado, por defecto; si el hosting no lo da, falla en vez de mandar la clave en claro) | no,
//   FTP_INSEGURO=1 acepta un certificado no válido.
// La clave nunca va en la línea de comandos: viaja en un archivo temporal de config de curl que se borra al terminar.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TANDA = 50; // archivos por conexión

function ftpConfig(v) {
  const host = String(v.FTP_HOST || '').trim().replace(/^ftps?:\/\//, '').replace(/\/+$/, '');
  const dir = String(v.FTP_DIR || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+(:\d+)?$/.test(host)) throw new Error('FTP_HOST no válido');
  if (!v.FTP_USER || !v.FTP_PASS) throw new Error('Faltan FTP_USER o FTP_PASS');
  if (dir && !/^[\w.\-/]+$/.test(dir)) throw new Error('FTP_DIR solo admite letras, números, _ . - y /');
  const tls = String(v.FTP_TLS || 'si').toLowerCase().replace('obligatorio', 'si');
  if (tls !== 'si' && tls !== 'no') throw new Error('FTP_TLS debe ser «si» o «no»');
  return { host, dir, user: v.FTP_USER, pass: v.FTP_PASS, tls, inseguro: v.FTP_INSEGURO === '1' };
}

// rel = ruta dentro de FTP_DIR (ej. «C2610_X_1x1/img/a.jpg»). Solo nombres seguros: nada que curl lea como patrón.
const SEGURA = /^[\w.\-/]+$/;
const ruta = (c, rel) => { if (!SEGURA.test(rel) || rel.includes('..')) throw new Error('Ruta FTP no válida: ' + rel); return (c.dir ? c.dir + '/' : '') + rel; };
const url = (c, rel) => 'ftp://' + c.host + '/' + ruta(c, rel);

function correr(c, args) {
  const tmp = path.join(os.tmpdir(), 'efe-ftp-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.cfg');
  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  fs.writeFileSync(tmp, 'user = ' + q(c.user + ':' + c.pass) + '\n', { mode: 0o600 });
  // --fail-early: en una tanda, un archivo que falla corta todo (si no, curl solo informa el último).
  // --speed-*: una transferencia trabada (menos de 1 KB/s durante 2 min) se corta en vez de comerse el job.
  const base = ['-K', tmp, '--silent', '--show-error', '--fail-early', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '120',
    '--retry', '2', '--retry-delay', '5', '--ftp-pasv'];
  if (c.tls === 'si') base.push('--ssl-reqd');
  if (c.inseguro) base.push('-k');
  return new Promise(ok => {
    const p = spawn('curl', [...base, ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.stdout.resume();
    p.on('error', e => { err += e.message; });
    p.on('close', code => { fs.rmSync(tmp, { force: true }); ok({ code: code ?? 1, err: err.trim().slice(0, 500) }); });
  });
}
const fallo = (que, r) => new Error(`${que}: curl ${r.code}${r.err ? ' · ' + r.err : ''}`);

// Baja un archivo. Devuelve false si no existe, lanza si es otro error (sin conexión, clave mala…).
async function bajar(c, rel, destino) {
  const r = await correr(c, ['-o', destino, url(c, rel)]);
  if (r.code === 0) return true;
  fs.rmSync(destino, { force: true });
  if (r.code === 78 || r.code === 9) return false; // 78: no existe el archivo; 9: aún no existe su carpeta
  throw fallo('No se pudo leer ' + rel, r);
}

// pares = [[archivoLocal, rel]]. Una conexión por tanda; si una tanda falla, se corta todo.
async function subir(c, pares, alAvanzar = () => {}) {
  for (let i = 0; i < pares.length; i += TANDA) {
    const args = ['--ftp-create-dirs'];
    for (const [local, rel] of pares.slice(i, i + TANDA)) args.push('-T', local, url(c, rel));
    const r = await correr(c, args);
    if (r.code !== 0) throw fallo('Falló la subida', r);
    alAvanzar(Math.min(i + TANDA, pares.length), pares.length);
  }
}

// Órdenes sueltas (RNFR/RNTO/DELE) antes de listar la carpeta raíz de FTP_DIR.
// Las rutas de estas órdenes van desde el inicio de la cuenta, no desde la carpeta de la URL.
const ordenes = (c, cmds) => correr(c, ['--list-only', '-o', os.devNull, ...cmds.flatMap(x => ['-Q', x]), 'ftp://' + c.host + '/']);

// Cambia de nombre (para que Meta nunca lea un CSV a medio subir). Si el servidor no pisa un archivo
// existente, borra el destino y reintenta (hueco de milisegundos), pero solo si el temporal sigue ahí
// (MDTM falla si no existe y curl corta antes del DELE): si el primer intento sí renombró, no se borra lo publicado.
async function renombrar(c, de, a) {
  let r = await ordenes(c, ['RNFR ' + ruta(c, de), 'RNTO ' + ruta(c, a)]);
  if (r.code === 0) return;
  r = await ordenes(c, ['MDTM ' + ruta(c, de), '*DELE ' + ruta(c, a), 'RNFR ' + ruta(c, de), 'RNTO ' + ruta(c, a)]);
  if (r.code !== 0) throw fallo(`No se pudo renombrar ${de} a ${a}`, r);
}

// Sube a un nombre temporal y lo renombra: la versión pública siempre está completa.
async function subirAtomico(c, local, rel) {
  await subir(c, [[local, rel + '.tmp']]);
  await renombrar(c, rel + '.tmp', rel);
}

// Borra archivos. «*» = si uno ya no existe, sigue con el resto. Devuelve los que se intentaron.
async function borrar(c, rels) {
  const hechos = [];
  for (let i = 0; i < rels.length; i += TANDA) {
    const t = rels.slice(i, i + TANDA);
    const r = await ordenes(c, t.map(rel => '*DELE ' + ruta(c, rel)));
    if (r.code !== 0) throw fallo('No se pudo borrar', r);
    hechos.push(...t);
  }
  return hechos;
}

module.exports = { ftpConfig, bajar, subir, subirAtomico, renombrar, borrar };
