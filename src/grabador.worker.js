// Escritura de la grabación (Web Worker). Recibe bloques de 8 canales del AudioWorklet y escribe,
// a medida que llegan, 7 archivos WAV de 24 bits a 48 kHz: 6 mono (FL, FR, C, LFE, RL, RR) y 1 estéreo
// (binaural). No acumula audio en memoria: cada bloque se convierte y se escribe enseguida.
//
// Dónde escribe: en el almacenamiento privado del navegador (OPFS), con FileSystemSyncAccessHandle,
// que escribe en el archivo real (en el sitio) y permite vaciar a disco con flush(). Cada 2 s se
// reescriben los encabezados con el largo actual y se vacía a disco: si el navegador se cierra de
// golpe, los archivos quedan válidos hasta ese momento. (Una carpeta elegida por el usuario solo se
// escribe de verdad al cerrar el archivo; por eso al terminar se copian ahí desde grabacion.js.)
//
// Mensajes: { tipo: 'iniciar', sesion, nombres[7], puerto } → { tipo: 'listo-para-grabar' }
//           (por el puerto) { canales } y { fin: true } → { tipo: 'terminado', sesion, nombres, muestras }

const FRECUENCIA = 48000;
const BYTES = 3; // 24 bits
let archivos = []; // { manejador, canales, datos (bytes escritos) }
let sesionDir = null;
let ultimoEncabezado = 0;
let muestras = 0;
let sesion = '';
let nombres = [];

function encabezado(canales, bytesDatos) {
  const b = new DataView(new ArrayBuffer(44));
  const texto = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  texto(0, 'RIFF');
  b.setUint32(4, 36 + bytesDatos, true);
  texto(8, 'WAVE');
  texto(12, 'fmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);                               // PCM
  b.setUint16(22, canales, true);
  b.setUint32(24, FRECUENCIA, true);
  b.setUint32(28, FRECUENCIA * canales * BYTES, true);   // bytes por segundo
  b.setUint16(32, canales * BYTES, true);                 // bytes por muestra (todos los canales)
  b.setUint16(34, BYTES * 8, true);
  texto(36, 'data');
  b.setUint32(40, bytesDatos, true);
  return new Uint8Array(b.buffer);
}

// Float32 (−1 a 1) → entero de 24 bits, little-endian, intercalando canales
function aPcm24(canales, n) {
  const salida = new Uint8Array(n * canales.length * BYTES);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (const c of canales) {
      let v = c[i];
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      const e = Math.round(v < 0 ? v * 8388608 : v * 8388607);
      salida[o++] = e & 255;
      salida[o++] = (e >> 8) & 255;
      salida[o++] = (e >> 16) & 255;
    }
  }
  return salida;
}

function actualizarEncabezados() {
  for (const a of archivos) a.manejador.write(encabezado(a.canales, a.datos), { at: 0 });
  for (const a of archivos) a.manejador.flush();
  ultimoEncabezado = performance.now();
}

function recibir(e) {
  const d = e.data;
  if (d.canales) {
    const n = d.canales[0].length;
    const grupos = [[0], [1], [2], [3], [4], [5], [6, 7]]; // 6 mono + binaural estéreo
    grupos.forEach((g, k) => {
      const bytes = aPcm24(g.map((c) => d.canales[c]), n);
      const a = archivos[k];
      a.manejador.write(bytes, { at: 44 + a.datos });
      a.datos += bytes.length;
    });
    muestras += n;
    if (performance.now() - ultimoEncabezado > 2000) actualizarEncabezados();
  }
  if (d.fin) terminar();
}

async function terminar() {
  actualizarEncabezados();
  for (const a of archivos) a.manejador.close();
  archivos = [];
  try { await sesionDir.removeEntry('en-curso'); } catch { /* ya no estaba */ }
  self.postMessage({ tipo: 'terminado', sesion, nombres, muestras });
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.tipo !== 'iniciar') return;
  try {
    sesion = d.sesion;
    nombres = d.nombres;
    const raiz = await navigator.storage.getDirectory();
    const grabaciones = await raiz.getDirectoryHandle('grabaciones', { create: true });
    sesionDir = await grabaciones.getDirectoryHandle(sesion, { create: true });
    // marca: si al abrir la app existe, la grabación se interrumpió (se puede recuperar)
    await (await sesionDir.getFileHandle('en-curso', { create: true })).createSyncAccessHandle().then((h) => h.close());
    archivos = [];
    for (let k = 0; k < nombres.length; k++) {
      const manejador = await (await sesionDir.getFileHandle(nombres[k], { create: true })).createSyncAccessHandle();
      manejador.truncate(0);
      const canales = k === 6 ? 2 : 1;
      manejador.write(encabezado(canales, 0), { at: 0 });
      archivos.push({ manejador, canales, datos: 0 });
    }
    ultimoEncabezado = performance.now();
    muestras = 0;
    d.puerto.onmessage = recibir;
    self.postMessage({ tipo: 'listo-para-grabar' });
  } catch (err) {
    self.postMessage({ tipo: 'error', mensaje: err.message });
  }
};
