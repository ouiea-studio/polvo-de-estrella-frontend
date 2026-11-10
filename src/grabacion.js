// Grabación de la obra (solo director, tecla R). Graba a la vez 6 WAV mono 48 kHz / 24 bits
// (FL, FR, C, LFE, RL, RR, la señal 5.1) y 1 WAV estéreo binaural, después del limitador y antes
// del silencio personal: si el director silencia su escucha, la grabación sigue.
//
// Flujo: salida.js arma la ruta de grabación y un AudioWorklet entrega el audio a un worker
// (grabador.worker.js) que lo escribe a disco a medida que llega, en el almacenamiento privado del
// navegador (OPFS), y actualiza los encabezados cada 2 s. Al detener, los archivos se copian en
// streaming (sin cargarlos en memoria) a la carpeta elegida con la File System Access API.
// Si el navegador se cerró en medio de una grabación, el panel A ofrece recuperarla.

import * as salida from './salida.js';

const CANALES = ['FL', 'FR', 'C', 'LFE', 'RL', 'RR', 'Binaural'];
const estado = { grabando: false, inicio: 0, exportando: '', carpeta: null, error: '' };
let toma = null, worker = null, sesionActual = null;
const oyentes = new Set();
export const alCambiar = (fn) => oyentes.add(fn);
const avisar = () => oyentes.forEach((fn) => fn());

// --- Carpeta de destino: se recuerda entre sesiones (IndexedDB guarda el permiso del navegador) ---
function bd() {
  return new Promise((ok, mal) => {
    const r = indexedDB.open('polvo-de-estrella', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('ajustes');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
}
async function guardarCarpeta(carpeta) {
  try { const d = await bd(); d.transaction('ajustes', 'readwrite').objectStore('ajustes').put(carpeta, 'carpeta'); } catch { /* sin IndexedDB: solo en memoria */ }
}
async function leerCarpeta() {
  try {
    const d = await bd();
    return await new Promise((ok) => { const r = d.transaction('ajustes').objectStore('ajustes').get('carpeta'); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); });
  } catch { return null; }
}
leerCarpeta().then((c) => { if (c && !estado.carpeta) { estado.carpeta = c; avisar(); } });

export const soportada = () => 'showDirectoryPicker' in window && 'storage' in navigator && !!navigator.storage.getDirectory;
export const nombreCarpeta = () => estado.carpeta?.name || '';

export async function elegirCarpeta() {
  const carpeta = await window.showDirectoryPicker({ id: 'polvo-grabaciones', mode: 'readwrite', startIn: 'music' });
  estado.carpeta = carpeta;
  await guardarCarpeta(carpeta);
  avisar();
  return carpeta;
}
// Para pruebas o consola: usar cualquier carpeta (por ejemplo una del almacenamiento privado).
export function fijarCarpeta(carpeta) { estado.carpeta = carpeta; avisar(); }

// Pide (o confirma) permiso de escritura; tiene que llamarse desde un gesto (clic o tecla).
async function carpetaConPermiso() {
  let c = estado.carpeta;
  if (!c) c = await elegirCarpeta();
  if (c.queryPermission && (await c.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await c.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Sin permiso para escribir en la carpeta');
  }
  return c;
}

const dos = (n) => String(n).padStart(2, '0');
function sello(d = new Date()) {
  return `PolvoDeEstrella_${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}_${dos(d.getHours())}-${dos(d.getMinutes())}`;
}

// --- Iniciar y detener ---
export async function alternar() {
  if (estado.grabando) return detener();
  return iniciar();
}

export async function iniciar() {
  if (estado.grabando || estado.exportando) return false;
  if (!salida.listo()) throw new Error('Activa el audio antes de grabar');
  if (!soportada()) throw new Error('Este navegador no permite grabar a una carpeta (usa Chrome)');
  await carpetaConPermiso(); // primero la carpeta: si se cancela, no se graba
  await salida.prepararGrabador();
  const base = sello();
  const sesion = base + '_' + Date.now().toString(36);
  const nombres = CANALES.map((c) => `${base}_${c}.wav`);
  worker = new Worker(new URL('./grabador.worker.js', import.meta.url), { type: 'module' });
  const canal = new MessageChannel();
  const listo = new Promise((ok, mal) => {
    worker.onmessage = (e) => {
      if (e.data.tipo === 'listo-para-grabar') ok();
      else if (e.data.tipo === 'error') mal(new Error(e.data.mensaje));
    };
  });
  worker.postMessage({ tipo: 'iniciar', sesion, nombres, puerto: canal.port2 }, [canal.port2]);
  await listo;
  toma = salida.abrirToma(canal.port1);
  sesionActual = { sesion, nombres };
  estado.grabando = true;
  estado.inicio = performance.now();
  estado.error = '';
  avisar();
  return true;
}

export async function detener() {
  if (!estado.grabando) return null;
  estado.grabando = false;
  estado.exportando = 'cerrando';
  avisar();
  const terminado = new Promise((ok) => {
    worker.onmessage = (e) => { if (e.data.tipo === 'terminado') ok(e.data); };
  });
  toma.grabador.port.postMessage('parar');
  const r = await terminado;
  toma.cerrar();
  worker.terminate();
  toma = worker = null;
  try {
    await exportar(r.sesion, r.nombres);
  } catch (err) {
    estado.error = 'No se pudo copiar a la carpeta: ' + err.message + '. La toma quedó guardada en el navegador; se puede recuperar desde el panel A.';
  }
  estado.exportando = '';
  avisar();
  return { ...r, segundos: r.muestras / 48000 };
}

// Copia una sesión del almacenamiento privado a la carpeta elegida, archivo por archivo, en streaming.
async function exportar(sesion, nombres) {
  const carpeta = await carpetaConPermiso();
  const raiz = await navigator.storage.getDirectory();
  const grabaciones = await raiz.getDirectoryHandle('grabaciones');
  const dir = await grabaciones.getDirectoryHandle(sesion);
  for (let k = 0; k < nombres.length; k++) {
    estado.exportando = `copiando ${k + 1} de ${nombres.length}`;
    avisar();
    const origen = await (await dir.getFileHandle(nombres[k])).getFile();
    const destino = await carpeta.getFileHandle(await nombreLibre(carpeta, nombres[k]), { create: true });
    await origen.stream().pipeTo(await destino.createWritable());
  }
  await grabaciones.removeEntry(sesion, { recursive: true }); // copiada: se libera el espacio
}
async function nombreLibre(carpeta, nombre) {
  for (let n = 1; ; n++) {
    const candidato = n === 1 ? nombre : nombre.replace(/\.wav$/, `-${n}.wav`);
    try { await carpeta.getFileHandle(candidato); } catch { return candidato; } // no existe: libre
  }
}

// --- Recuperación: tomas que quedaron en el navegador (cierre brusco o copia fallida) ---
export async function pendientes() {
  if (!soportada() || estado.grabando || estado.exportando) return [];
  try {
    const grabaciones = await (await navigator.storage.getDirectory()).getDirectoryHandle('grabaciones');
    const lista = [];
    for await (const [nombre, h] of grabaciones.entries()) if (h.kind === 'directory' && nombre !== sesionActual?.sesion) lista.push(nombre);
    return lista;
  } catch { return []; }
}
export async function recuperar() {
  const grabaciones = await (await navigator.storage.getDirectory()).getDirectoryHandle('grabaciones');
  let n = 0;
  for (const sesion of await pendientes()) {
    const dir = await grabaciones.getDirectoryHandle(sesion);
    const nombres = [];
    for await (const [nombre, h] of dir.entries()) if (h.kind === 'file' && nombre.endsWith('.wav')) nombres.push(nombre);
    estado.exportando = 'recuperando';
    avisar();
    await exportar(sesion, nombres);
    n++;
  }
  estado.exportando = '';
  avisar();
  return n;
}

export function info() {
  return {
    grabando: estado.grabando,
    segundos: estado.grabando ? (performance.now() - estado.inicio) / 1000 : 0,
    exportando: estado.exportando,
    carpeta: nombreCarpeta(),
    error: estado.error,
  };
}
