// Salida de audio · domo. Es la etapa final de la app, por debajo de Tone.js:
//  · un AudioContext nativo a 48 kHz que Tone.js usa como propio (así hay un solo motor de audio)
//  · el dispositivo de salida (setSinkId) y el número de canales del destino, siempre discretos
//  · dos modos: ESTÉREO (como en la V3) y 5.1 (cada instrumento repartido en los 6 canales del domo)
//  · un limitador enlazado para todos los canales y medidores por canal de lo que sale de verdad
//  · señales de prueba (ruido rosa por un solo canal)
// Todo es local de este computador: no se sincroniza con el servidor. Los ajustes se guardan en localStorage.
//
// Grafo:
//   voz ─ entrada mono ─┬─ paneo ─ espacio ─────────────► bus estéreo ──► puertas ─┐
//                       │            └─ envíos a reverb y delay ─► bus efectos ─► puertas ─┤
//                       └─ distancia ─┬─ FL FR C RL RR ─► buses por canal ─► puertas ─┤
//                                     └─ envío LFE ─► bus LFE (LR4 120 Hz) ─► canal LFE ┘
//   puertas ─► mezcla (N canales) ─► limitador ─► maestro (silencios) ─► final ─► dispositivo
//                                                        señal de prueba ─┘   └─► medidores
// Las "puertas" deciden qué llega a cada canal según el modo; cambian con rampas de ~50 ms.

import * as Tone from 'tone';
// no-inline: en producción el worklet va como archivo propio (no como data: URL, que no todos aceptan)
import urlLimitador from './limitador.worklet.js?url&no-inline';
import urlGrabador from './grabador.worklet.js?url&no-inline';
import { RADIO_PANEO, RADIO_UNIVERSO } from './escena.js';

// Mapa del domo: posición en esta lista = canal físico − 1
export const CANALES = [
  { id: 'FL', salida: 'MON L', desc: 'Frontal izquierdo' },
  { id: 'FR', salida: 'MON R', desc: 'Frontal derecho' },
  { id: 'C', salida: 'LINE 1', desc: 'Centro · cenit' },
  { id: 'LFE', salida: 'LINE 2', desc: 'Subgrave < 120 Hz' },
  { id: 'RL', salida: 'LINE 3', desc: 'Trasero izquierdo' },
  { id: 'RR', salida: 'LINE 4', desc: 'Trasero derecho' },
];
const I = Object.fromEntries(CANALES.map((c, i) => [c.id, i]));
export const ANILLO = ['FL', 'FR', 'RR', 'RL']; // parlantes del anillo (el C está en el cenit)

export const FRECUENCIA = 48000;
const TAU = 0.017;          // constante de tiempo de las rampas: ~50 ms hasta el 95 %
const RECORTE = 0.8;        // nivel del bus maestro (igual que en la V3)
const ENVOLVENTE = RECORTE * Math.SQRT1_2; // retorno de efectos repartido en dos parlantes (misma potencia)
const CORTE_LFE = 120;

// =====================================================================
// AJUSTES (localStorage)
// =====================================================================
const CLAVE = 'onlineband.domo';
export const POR_DEFECTO = Object.freeze({
  dispositivo: { id: '', nombre: '' },  // '' = salida del sistema
  modo: 'estereo',                      // 'estereo' | '5.1'
  canales: 6,                           // canales del destino: 6, 8 o 16
  nivelPrueba: -30,                     // dBFS RMS del ruido rosa
  angulos: { FL: -45, FR: 45, RR: 135, RL: -135 },
  radioCentro: 0.35,                    // fracción del radio de la estación donde termina el paso C → anillo
  atenuacionBorde: -6,                  // dB en el borde de la estación (modo 5.1)
  nivelLFE: 0,                          // dB, nivel general del subgrave
  orientacion: 0,                       // grados: gira toda la escena sonora (positivo = hacia la derecha)
});
const numeroEn = (v, min, max, def) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(max, Math.max(min, +v)) : def);
function sanear(g) {
  const d = structuredClone(POR_DEFECTO);
  if (!g || typeof g !== 'object') return d;
  if (g.dispositivo && typeof g.dispositivo.id === 'string') d.dispositivo = { id: g.dispositivo.id, nombre: String(g.dispositivo.nombre || '') };
  if (['estereo', '5.1'].includes(g.modo)) d.modo = g.modo;
  if ([6, 8, 16].includes(+g.canales)) d.canales = +g.canales;
  d.nivelPrueba = numeroEn(g.nivelPrueba, -60, -14, d.nivelPrueba);
  for (const id of ANILLO) d.angulos[id] = numeroEn(g.angulos?.[id], -180, 180, d.angulos[id]);
  d.radioCentro = numeroEn(g.radioCentro, 0, 1, d.radioCentro);
  d.atenuacionBorde = numeroEn(g.atenuacionBorde, -24, 0, d.atenuacionBorde);
  d.nivelLFE = numeroEn(g.nivelLFE, -24, 6, d.nivelLFE);
  d.orientacion = numeroEn(g.orientacion, -180, 180, d.orientacion);
  return d;
}
function cargar() {
  try { return sanear(JSON.parse(localStorage.getItem(CLAVE) || 'null')); } catch { return sanear(null); }
}
function guardar() {
  try { localStorage.setItem(CLAVE, JSON.stringify(ajustes)); } catch { /* sin almacenamiento: se usa en memoria */ }
}
export const ajustes = cargar();

// Avisos para el panel y el radar cuando cambia algo
const oyentes = new Set();
export function alCambiar(fn) { oyentes.add(fn); return () => oyentes.delete(fn); }
const avisar = () => oyentes.forEach((fn) => fn());

// =====================================================================
// GEOMETRÍA: posición de una pieza → ganancias
// Plano de la estación: X a la derecha (marca D), −Z hacia el fondo de la escena (el frente).
// Acimut: 0° = frente, +90° = derecha, ±180° = atrás.
// =====================================================================
const grados = (r) => r * 180 / Math.PI;
const rad = (g) => g * Math.PI / 180;
const normalizar = (a) => { const b = ((a + 180) % 360 + 360) % 360 - 180; return b === -180 ? 180 : b; };

// Estéreo (V3): paneo por X y volumen que baja en línea recta hasta el borde.
export function mezclaEstereo(x, z) {
  return {
    paneo: Math.max(-1, Math.min(1, x / RADIO_PANEO)),
    volumen: 1 - Math.min(Math.hypot(x, z) / RADIO_UNIVERSO, 1),
  };
}

// VBAP 2D: reparte entre los dos parlantes vecinos del anillo con potencia constante.
export function vbap(acimut, angulos = ajustes.angulos) {
  const g = { FL: 0, FR: 0, RR: 0, RL: 0 };
  const lista = ANILLO.map((id) => ({ id, a: normalizar(angulos[id]) })).sort((p, q) => p.a - q.a);
  for (let k = 0; k < lista.length; k++) {
    const A = lista[k], B = lista[(k + 1) % lista.length];
    const ancho = ((B.a - A.a) % 360 + 360) % 360 || 360;  // arco de A a B en sentido horario
    const d = ((acimut - A.a) % 360 + 360) % 360;
    if (d > ancho) continue;
    if (ancho < 179) {
      // vectores unitarios (x = derecha, y = frente): p = gA·lA + gB·lB
      const ax = Math.sin(rad(A.a)), ay = Math.cos(rad(A.a));
      const bx = Math.sin(rad(B.a)), by = Math.cos(rad(B.a));
      const px = Math.sin(rad(acimut)), py = Math.cos(rad(acimut));
      const det = ax * by - bx * ay;
      const gA = Math.max(0, (px * by - bx * py) / det), gB = Math.max(0, (ax * py - px * ay) / det);
      const n = Math.hypot(gA, gB) || 1;
      g[A.id] += gA / n; g[B.id] += gB / n;
    } else {
      // arco de 180° o más: VBAP no sirve; paneo de potencia constante por fracción del arco
      const t = d / ancho;
      g[A.id] += Math.cos(t * Math.PI / 2); g[B.id] += Math.sin(t * Math.PI / 2);
    }
    return g;
  }
  return g;
}

// 5.1: ángulo → par de parlantes del anillo; distancia → paso del C (cenit) al anillo y volumen suave.
export function mezcla51(x, z, a = ajustes) {
  const r = Math.min(Math.hypot(x, z) / RADIO_UNIVERSO, 1);
  const acimut = normalizar(grados(Math.atan2(x, -z)) + a.orientacion);
  const u = a.radioCentro > 0 ? Math.min(r / a.radioCentro, 1) : 1;
  const gC = Math.cos(u * Math.PI / 2), gAnillo = Math.sin(u * Math.PI / 2); // fundido de potencia constante
  const anillo = vbap(acimut, a.angulos);
  const ganancias = { C: gC };
  for (const id of ANILLO) ganancias[id] = gAnillo * anillo[id];
  return { ganancias, distancia: 10 ** (a.atenuacionBorde * r / 20), acimut, centro: gC * gC };
}

// Posición en el plano (app) de cada parlante del anillo, para dibujarlo en el radar.
export function acimutParlante(id, a = ajustes) { return normalizar(a.angulos[id] - a.orientacion); }

// =====================================================================
// MOTOR
// =====================================================================
let ctx = null;               // AudioContext nativo (también es el de Tone.js)
let buses = null;             // buses y puertas: se crean una vez
let etapa = null;             // mezcla, limitador, medidores: se rehacen al cambiar de dispositivo o de canales
let numCanales = 2;
let modoEfectivo = 'estereo'; // el 5.1 solo se activa si el dispositivo tiene 6 canales o más
// Todos empiezan en silencio: el motor corre (las gemas reaccionan a las notas) pero no suena.
// Solo el computador del director pulsa ESCUCHAR (estado "Todo", tecla H).
let silencioPersonal = true;
let prueba = null;            // { canal, src, g }
let reduccion = 0;            // dB que está bajando el limitador
let errorSalida = '';
const espaciales = new Set();

const dbAGanancia = (db) => 10 ** (db / 20);
const rampa = (param, v) => { if (ctx) param.setTargetAtTime(v, ctx.currentTime, TAU); };
const mono = (nodo) => Object.assign(nodo, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });

// Crea el AudioContext a 48 kHz y se lo da a Tone.js. Debe llamarse antes de crear cualquier nodo de Tone.
export function contexto() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: FRECUENCIA, latencyHint: 'balanced' });
    Tone.setContext(new Tone.Context(ctx));
    ctx.addEventListener('statechange', avisar);
  }
  return ctx;
}
export const listo = () => !!buses;

// Se llama una vez, al encender el audio (después de Tone.start).
export async function prepararSalida() {
  contexto();
  if (buses) return;
  await ctx.audioWorklet.addModule(urlLimitador);
  buses = crearBuses();
  await aplicarDispositivo();
}

function crearBuses() {
  const g = (v = 1) => new GainNode(ctx, { gain: v });
  const estereo = Object.assign(g(), { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const efectos = Object.assign(g(), { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const canales = CANALES.map(() => mono(g()));
  // LFE: Linkwitz-Riley de 4.º orden en 120 Hz (dos Butterworth en cascada, 24 dB/oct)
  // y un pasaaltos en 20 Hz que protege los subwoofers de lo que no se oye.
  const lfe = mono(g());
  const nivelLFE = g(dbAGanancia(ajustes.nivelLFE));
  const filtro = (type, frequency) => new BiquadFilterNode(ctx, { type, frequency, Q: Math.SQRT1_2 });
  lfe.connect(filtro('highpass', 20)).connect(filtro('lowpass', CORTE_LFE)).connect(filtro('lowpass', CORTE_LFE))
    .connect(nivelLFE).connect(canales[I.LFE]);

  const sepEstereo = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const sepEfectos = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  estereo.connect(sepEstereo);
  efectos.connect(sepEfectos);
  const puertas = [];
  const puerta = (origen, salida, canal, valores) => {
    const p = g(0);
    origen.connect(p, salida);
    puertas.push({ p, canal, valores });
  };
  // seco estéreo: solo en modo estéreo, por los canales 1 y 2
  puerta(sepEstereo, 0, I.FL, { estereo: RECORTE, '5.1': 0 });
  puerta(sepEstereo, 1, I.FR, { estereo: RECORTE, '5.1': 0 });
  // reverb y delay: en 5.1 el retorno izquierdo va a FL y RL, el derecho a FR y RR (envuelven la sala)
  puerta(sepEfectos, 0, I.FL, { estereo: RECORTE, '5.1': ENVOLVENTE });
  puerta(sepEfectos, 0, I.RL, { estereo: 0, '5.1': ENVOLVENTE });
  puerta(sepEfectos, 1, I.FR, { estereo: RECORTE, '5.1': ENVOLVENTE });
  puerta(sepEfectos, 1, I.RR, { estereo: 0, '5.1': ENVOLVENTE });
  // buses 5.1: uno por canal
  canales.forEach((c, k) => puerta(c, 0, k, { estereo: 0, '5.1': RECORTE }));
  return { estereo, efectos, canales, lfe, nivelLFE, puertas, sepEfectos };
}

// Cambia la salida al dispositivo guardado en los ajustes y rehace la etapa con sus canales.
async function aplicarDispositivo() {
  errorSalida = '';
  const { id } = ajustes.dispositivo;
  try {
    // Safari y Firefox no tienen setSinkId en AudioContext: suenan por la salida del sistema
    if ('setSinkId' in ctx && ctx.sinkId !== id) await ctx.setSinkId(id === 'default' ? '' : id);
  } catch (e) {
    errorSalida = `No se pudo usar el dispositivo elegido (${e.name}). Suena por la salida del sistema.`;
    try { await ctx.setSinkId(''); } catch { /* ya está en la del sistema */ }
  }
  // al cambiar de salida Chrome puede dejar el contexto en pausa un instante
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  construirEtapa();
  return !errorSalida;
}

function construirEtapa() {
  pararPrueba();
  if (etapa) {
    etapa.final.disconnect();
    etapa.limitador.port.onmessage = null;
    etapa.limitador.disconnect();
    for (const { p } of buses.puertas) p.disconnect();
  }
  const max = ctx.destination.maxChannelCount;
  const n = max >= 6 ? Math.min(ajustes.canales, max) : Math.max(1, Math.min(2, max));
  numCanales = n;
  const destino = ctx.destination;
  destino.channelCount = n;
  destino.channelCountMode = 'explicit';
  destino.channelInterpretation = 'discrete';
  const discreto = (nodo) => Object.assign(nodo, { channelCount: n, channelCountMode: 'explicit', channelInterpretation: 'discrete' });

  const mezcla = new ChannelMergerNode(ctx, { numberOfInputs: n });
  const limitador = new AudioWorkletNode(ctx, 'limitador-enlazado', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [n],
    channelCount: n, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    processorOptions: { umbralDb: -1, anticipacionMs: 3, liberacionMs: 120 },
  });
  const maestro = discreto(new GainNode(ctx, { gain: nivelMaestro() }));
  const mezclaPrueba = new ChannelMergerNode(ctx, { numberOfInputs: n });
  const final = discreto(new GainNode(ctx));
  mezcla.connect(limitador).connect(maestro).connect(final);
  mezclaPrueba.connect(final);
  final.connect(destino);
  const separador = new ChannelSplitterNode(ctx, { numberOfOutputs: n });
  final.connect(separador);
  const medidores = CANALES.map((_, i) => {
    if (i >= n) return null;
    const a = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    separador.connect(a, i);
    return a;
  });
  limitador.port.onmessage = (e) => { reduccion = e.data; };
  for (const { p, canal } of buses.puertas) if (canal < n) p.connect(mezcla, 0, canal);
  etapa = { mezcla, limitador, maestro, mezclaPrueba, final, medidores };
  aplicarModo();
}

function aplicarModo() {
  modoEfectivo = ajustes.modo === '5.1' && numCanales >= 6 ? '5.1' : 'estereo';
  if (buses) for (const { p, valores } of buses.puertas) rampa(p.gain, valores[modoEfectivo]);
  espaciales.forEach(actualizarEspacial);
  avisar();
}

const nivelMaestro = () => (silencioPersonal || prueba ? 0 : telon);
function aplicarMaestro() { if (etapa) rampa(etapa.maestro.gain, nivelMaestro()); }

// =====================================================================
// VOCES: la parte espacial de cada instrumento (la crea audio.js)
// =====================================================================
export function crearEspacial() {
  const entrada = mono(new GainNode(ctx));
  const paneo = new StereoPannerNode(ctx, { pan: 0 });
  const espacio = new GainNode(ctx, { gain: 0 }); // seco estéreo y punto de envío a los efectos
  // "seco" y "seco51": solo el sonido directo (no los envíos). El final de la obra los apaga mientras
  // los envíos a reverb y delay siguen (el "wash"); ver audio.js, iniciarFinal.
  const seco = new GainNode(ctx, { gain: 1 }), seco51 = new GainNode(ctx, { gain: 1 });
  entrada.connect(paneo).connect(espacio).connect(seco).connect(buses.estereo);
  const distancia = new GainNode(ctx, { gain: 0 }); // 5.1: volumen por distancia
  entrada.connect(distancia).connect(seco51);
  const parlantes = {};
  for (const id of ['FL', 'FR', 'C', 'RL', 'RR']) {
    parlantes[id] = new GainNode(ctx, { gain: 0 });
    seco51.connect(parlantes[id]).connect(buses.canales[I[id]]);
  }
  const lfe = new GainNode(ctx, { gain: 0 });
  seco51.connect(lfe).connect(buses.lfe);
  const e = { entrada, paneo, espacio, seco, seco51, distancia, parlantes, lfe, x: 0, z: 0 };
  espaciales.add(e);
  return e;
}

function actualizarEspacial(e) {
  const est = mezclaEstereo(e.x, e.z);
  const m = mezcla51(e.x, e.z);
  rampa(e.paneo.pan, est.paneo);
  // el espacio alimenta el seco estéreo y los envíos: en 5.1 usa la atenuación suave del 5.1
  rampa(e.espacio.gain, modoEfectivo === '5.1' ? m.distancia : est.volumen);
  rampa(e.distancia.gain, m.distancia);
  for (const id in e.parlantes) rampa(e.parlantes[id].gain, m.ganancias[id]);
}

export function posicionar(e, x, z) { e.x = x; e.z = z; actualizarEspacial(e); }
export function fijarEnvioLFE(e, v) { rampa(e.lfe.gain, v); }
export function quitarEspacial(e) {
  espaciales.delete(e);
  rampa(e.espacio.gain, 0);
  rampa(e.distancia.gain, 0);
  setTimeout(() => {
    for (const nodo of [e.entrada, e.paneo, e.espacio, e.seco, e.seco51, e.distancia, e.lfe, ...Object.values(e.parlantes)]) nodo.disconnect();
  }, 300);
}
export const busEfectos = () => buses.efectos;

// Disolución de un módulo: rampa lineal de la entrada de su parte espacial (todo su sonido, incluidos
// los envíos a efectos) hasta "objetivo" en "segundos".
export function fundirEspacial(e, objetivo, segundos) {
  rampaLineal(e.entrada.gain, objetivo, segundos);
}
// Solo el sonido directo (estéreo y 5.1, con su LFE); los envíos a efectos siguen.
export function fundirSeco(e, objetivo, segundos) {
  rampaLineal(e.seco.gain, objetivo, segundos);
  rampaLineal(e.seco51.gain, objetivo, segundos);
}
function rampaLineal(g, objetivo, segundos) {
  const t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(objetivo, t + Math.max(segundos, 0.02));
}

// Telón: al terminar el final de la obra (y sus colas) la salida va a silencio total; REABRIR lo
// levanta. Se suma al silencio personal y al de la señal de prueba.
let telon = 1;
export function fijarTelon(v, segundos = 2) {
  telon = v;
  if (!etapa || silencioPersonal || prueba) return;
  rampaLineal(etapa.maestro.gain, nivelMaestro(), segundos);
}

// =====================================================================
// GRABACIÓN — una ruta aparte, siempre en 5.1 (aunque se escuche en estéreo):
//   buses 5.1 + efectos (L → FL y RL, R → FR y RR) → limitador de 6 canales → 6 canales
//   y, de esos 6, una versión BINAURAL: cada parlante del domo virtualizado con HRTF
//   (FL −45°, FR +45°, RL −135°, RR +135° a la altura del oído, C en el cenit) + LFE a −6 dB
//   en los dos oídos → limitador estéreo.
//   Todo va a un AudioWorklet "grabador" de 8 canales que entrega bloques a un worker por un
//   MessagePort (el hilo principal no toca el audio). Se toma ANTES del silencio personal.
// =====================================================================
const POSICION_HRTF = { FL: [-Math.SQRT1_2, 0, -Math.SQRT1_2], FR: [Math.SQRT1_2, 0, -Math.SQRT1_2], C: [0, 1, 0], RL: [-Math.SQRT1_2, 0, Math.SQRT1_2], RR: [Math.SQRT1_2, 0, Math.SQRT1_2] };
let grabadorCargado = null;
export function abrirToma(puertoDatos) {
  if (!buses) throw new Error('El audio no está activo');
  const nodos = [], tomas = []; // nodos propios y conexiones que salen de los buses (para soltarlas al final)
  const nodo = (n) => { nodos.push(n); return n; };
  const tomar = (origen, destino, salida = 0) => { tomas.push([origen, destino, salida]); return origen.connect(destino, salida); };
  const mezcla6 = nodo(new ChannelMergerNode(ctx, { numberOfInputs: 6 }));
  buses.canales.forEach((c, k) => tomar(c, nodo(new GainNode(ctx, { gain: RECORTE }))).connect(mezcla6, 0, k));
  for (const [salidaEf, canal] of [[0, I.FL], [0, I.RL], [1, I.FR], [1, I.RR]]) {
    tomar(buses.sepEfectos, nodo(new GainNode(ctx, { gain: ENVOLVENTE })), salidaEf).connect(mezcla6, 0, canal);
  }
  const limitador = (n) => nodo(new AudioWorkletNode(ctx, 'limitador-enlazado', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [n],
    channelCount: n, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    processorOptions: { umbralDb: -1, anticipacionMs: 3, liberacionMs: 120 },
  }));
  const lim6 = limitador(6);
  mezcla6.connect(lim6);
  const sep6 = nodo(new ChannelSplitterNode(ctx, { numberOfOutputs: 6 }));
  lim6.connect(sep6);
  const mezcla8 = nodo(new ChannelMergerNode(ctx, { numberOfInputs: 8 }));
  for (let k = 0; k < 6; k++) sep6.connect(mezcla8, k, k);
  // binaural
  const binaural = nodo(Object.assign(new GainNode(ctx), { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }));
  for (const id of ['FL', 'FR', 'C', 'RL', 'RR']) {
    const [x, y, z] = POSICION_HRTF[id];
    const p = nodo(new PannerNode(ctx, {
      panningModel: 'HRTF', distanceModel: 'linear', refDistance: 1, maxDistance: 10, rolloffFactor: 0,
      positionX: x, positionY: y, positionZ: z,
    }));
    sep6.connect(p, I[id]).connect(binaural);
  }
  sep6.connect(nodo(new GainNode(ctx, { gain: 0.5 })), I.LFE).connect(binaural); // mono → los dos oídos
  const lim2 = limitador(2);
  binaural.connect(lim2);
  const sep2 = nodo(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
  lim2.connect(sep2);
  sep2.connect(mezcla8, 0, 6);
  sep2.connect(mezcla8, 1, 7);
  const grabador = nodo(new AudioWorkletNode(ctx, 'grabador', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 8, channelCountMode: 'explicit', channelInterpretation: 'discrete',
  }));
  mezcla8.connect(grabador);
  grabador.connect(nodo(new GainNode(ctx, { gain: 0 }))).connect(ctx.destination); // para que el navegador lo procese
  grabador.port.postMessage({ puerto: puertoDatos }, [puertoDatos]);
  return {
    grabador,
    cerrar() {
      tomas.forEach(([o, d, s]) => o.disconnect(d, s));
      nodos.forEach((n) => n.disconnect());
    },
  };
}
export async function prepararGrabador() {
  grabadorCargado ||= ctx.audioWorklet.addModule(urlGrabador);
  return grabadorCargado;
}
// Para revisar desde la consola: (await import('/src/salida.js')).diagnostico()
export const diagnostico = () => ({ ctx, buses, etapa, numCanales, modoEfectivo, espaciales: espaciales.size });

// =====================================================================
// CONTROLES (panel)
// =====================================================================
export function silenciar(si) { silencioPersonal = si; aplicarMaestro(); avisar(); }
export const silenciado = () => silencioPersonal;

export async function elegirDispositivo(id, nombre) {
  ajustes.dispositivo = { id, nombre };
  guardar();
  if (!buses) { avisar(); return true; }
  return aplicarDispositivo();
}

// Cambia un ajuste del panel y lo aplica al instante. ruta: 'modo', 'angulos.FL', 'radioCentro'…
export function fijarAjuste(ruta, valor) {
  const [a, b] = ruta.split('.');
  if (b) ajustes[a][b] = valor; else ajustes[a] = valor;
  Object.assign(ajustes, sanear(ajustes));
  guardar();
  if (!buses) { avisar(); return; }
  if (a === 'canales') construirEtapa();
  else if (a === 'modo') aplicarModo();
  else if (a === 'nivelLFE') { rampa(buses.nivelLFE.gain, dbAGanancia(ajustes.nivelLFE)); avisar(); }
  else if (a === 'nivelPrueba') { if (prueba) rampa(prueba.g.gain, dbAGanancia(ajustes.nivelPrueba)); avisar(); }
  else { espaciales.forEach(actualizarEspacial); avisar(); }
}

// Vuelve a los valores por defecto la espacialización 5.1 (no toca dispositivo, modo ni canales).
export function restablecer51() {
  for (const k of ['angulos', 'radioCentro', 'atenuacionBorde', 'nivelLFE', 'orientacion']) ajustes[k] = structuredClone(POR_DEFECTO[k]);
  guardar();
  if (buses) { rampa(buses.nivelLFE.gain, dbAGanancia(ajustes.nivelLFE)); espaciales.forEach(actualizarEspacial); }
  avisar();
}

export function estado() {
  return {
    activo: !!buses,
    estadoContexto: ctx?.state || 'apagado',
    frecuencia: ctx?.sampleRate || null,
    maxCanales: ctx ? ctx.destination.maxChannelCount : null,
    canales: buses ? numCanales : null,
    interpretacion: ctx?.destination.channelInterpretation,
    latenciaBase: ctx?.baseLatency, latenciaSalida: ctx?.outputLatency,
    reduccion: buses ? reduccion : 0,
    modo: modoEfectivo, modoPedido: ajustes.modo,
    prueba: prueba ? prueba.canal : null,
    error: errorSalida,
  };
}

// Nivel RMS de cada canal de salida, en dBFS (null si ese canal no existe en el dispositivo).
const muestras = new Float32Array(2048);
export function niveles() {
  return CANALES.map((_, i) => {
    const a = etapa?.medidores[i];
    if (!a) return null;
    a.getFloatTimeDomainData(muestras);
    let s = 0;
    for (let k = 0; k < muestras.length; k++) s += muestras[k] * muestras[k];
    const rms = Math.sqrt(s / muestras.length);
    return rms > 1e-7 ? 20 * Math.log10(rms) : -Infinity;
  });
}

// =====================================================================
// SEÑAL DE PRUEBA: ruido rosa por un solo canal (el LFE, solo por debajo de 120 Hz).
// Mientras suena, la música se silencia; al parar vuelve.
// =====================================================================
let ruido = null;
function ruidoRosa(segundos = 10) {
  // método de Paul Kellet; el final del búfer se funde con el principio para que el lazo no haga clic
  const sr = ctx.sampleRate, n = Math.round(sr * segundos), f = Math.round(sr * 0.25);
  const crudo = new Float32Array(n + f);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let k = 0; k < crudo.length; k++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    crudo[k] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  for (let k = 0; k < n; k++) d[k] = crudo[k];
  for (let k = 0; k < f; k++) { const a = (k / f) * Math.PI / 2; d[k] = crudo[k] * Math.sin(a) + crudo[n + k] * Math.cos(a); }
  let media = 0;
  for (let k = 0; k < n; k++) media += d[k];
  media /= n;
  let s = 0;
  for (let k = 0; k < n; k++) { d[k] -= media; s += d[k] * d[k]; }
  const rms = Math.sqrt(s / n);
  for (let k = 0; k < n; k++) d[k] /= rms; // RMS 1: el nivel lo pone la ganancia
  return buf;
}

export function probarCanal(i) {
  if (!etapa || i >= numCanales) return false;
  ruido ||= ruidoRosa();
  soltarPrueba();
  const t = ctx.currentTime;
  const src = new AudioBufferSourceNode(ctx, { buffer: ruido, loop: true });
  let ultimo = src;
  if (CANALES[i].id === 'LFE') {
    const f = (type, frequency) => new BiquadFilterNode(ctx, { type, frequency, Q: Math.SQRT1_2 });
    ultimo = src.connect(f('highpass', 20)).connect(f('lowpass', CORTE_LFE)).connect(f('lowpass', CORTE_LFE));
  }
  const g = new GainNode(ctx, { gain: 0 });
  ultimo.connect(g).connect(etapa.mezclaPrueba, 0, i);
  src.start(t, Math.random() * ruido.duration);
  rampa(g.gain, dbAGanancia(ajustes.nivelPrueba));
  prueba = { canal: i, src, g };
  aplicarMaestro();
  avisar();
  return true;
}

function soltarPrueba() {
  if (!prueba) return;
  const { src, g } = prueba;
  prueba = null;
  rampa(g.gain, 0);
  src.stop(ctx.currentTime + 0.12);
  src.onended = () => g.disconnect();
}

export function pararPrueba() {
  if (!prueba) return;
  soltarPrueba();
  aplicarMaestro(); // la música vuelve
  avisar();
}
