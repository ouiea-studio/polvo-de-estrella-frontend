// Polvo de Estrella · frontend (nombre técnico del proyecto: OnlineBandApp).
// Conecta con el servidor, mantiene una copia local de la sala, la dibuja como gemas en el universo
// y la hace sonar con Tone.js (audio.js). Cada tripulante solo puede mover, editar y eliminar
// sus propias piezas; tempo y escala son de todos. El servidor manda la física (choques) y la vida
// de cada módulo (se disuelve en polvo de estrella si su dueño no lo toca); aquí se interpola y se dibuja.

import './estilo.css';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import {
  camera, controls, renderer, scene, params, RADIO_PANEO, RADIO_UNIVERSO,
  pulsoRGB, dibujar, ajustarTamanoEscena, recentrar, MARCAS_PANEO, actualizarParlantes, POS_PARLANTES, referencia,
} from './escena.js';
import {
  cargarPlantillas, crearGema, destruirGema, colorearGema, animarGema, golpearGema,
  aplicarVidrio, actualizarEscalaNubes, TALLAS, disolverGema, soltarPolvo, apagarPolvoSuelto, animarPolvoSuelto,
} from './gemas.js';
import { escalaVisual, gelatinaDe, tiemposGiro, desplazamientoFx } from './movimiento.js';
import { modulados } from './lfo.js';
import { lanzar as lanzarFantasma, animarFantasmas, phaser as fantasmasPhaser } from './fantasmas.js';
import { patronAleatorio } from './azar.js';
import * as grabacion from './grabacion.js';
import {
  MODULOS, ETIQUETAS, TONALIDADES, MODOS, nombreNota, nombreEscala, coord, dosCifras, registrar, actualizarTelemetria, escribiendo,
  CURSOR_RETICULA, CURSOR_MODULO, CURSOR_AJENO,
} from './hud.js';
import { crearPanel } from './panel.js';
import { crearEditor } from './editor.js';
import * as audio from './audio.js';
import * as salida from './salida.js';
import { crearDomo } from './domo.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// =====================================================================
// ESTADO LOCAL — copia de lo que dice el servidor
// =====================================================================
const sala = {
  tempo: 70, escala: { tonica: 'D', modo: 'dorico' }, tripulantes: new Map(),
  ajustes: { inactividad: 45, disolucion: 2.5, final: 20 }, obra: 'abierta',
};
let yo = null; // { id, indicativo, color } asignado por el servidor
// id → { id, tipo, dueno, inst (datos completos del servidor), gema, etiqueta, semilla,
//        destino (posición que manda el servidor), base (posición suavizada), fx (desplazamiento por FX),
//        giro / giroObj (rotación por notas), escala, actividad y ladeo (inclinación por notas),
//        disolucion ({ desde, duracion } mientras se disuelve), reviviendo, mezcla (última posición al audio) }
const piezas = new Map();

const colorDe = (id) => sala.tripulantes.get(id)?.color || '#dfe6ff';
const indicativoDe = (id) => sala.tripulantes.get(id)?.indicativo || 'Tripulante --';
const esMia = (p) => !!yo && p.dueno === yo.id;

const elHud = document.getElementById('hud');
const lienzo = renderer.domElement;

// =====================================================================
// PIEZAS: crear, actualizar y quitar gemas según el estado del servidor
// =====================================================================
// Bajo cada gema: las propias muestran el módulo y "· tú" ("arm · tú"); las de otros, solo su
// tripulante ("tripulante 07").
function textoEtiqueta(p) {
  const b = document.createElement('b');
  b.textContent = esMia(p) ? ETIQUETAS[p.tipo] : indicativoDe(p.dueno).toLowerCase();
  p.etiqueta.replaceChildren(b, esMia(p) ? ' · tú' : '');
  p.etiqueta.style.setProperty('--acento', colorDe(p.dueno));
}

function agregarPieza(inst) {
  const existente = piezas.get(inst.id);
  if (existente) { existente.destino.set(inst.x, 0, inst.z); actualizarDatos(existente, inst); return existente; }
  const gema = crearGema(inst.tipo, colorDe(inst.dueno));
  gema.grupo.position.set(inst.x, 0, inst.z);
  const etiqueta = document.createElement('div');
  etiqueta.className = 'etiqueta';
  elHud.appendChild(etiqueta);
  const p = {
    id: inst.id, tipo: inst.tipo, dueno: inst.dueno, inst, gema, etiqueta, semilla: Math.random(),
    destino: new THREE.Vector3(inst.x, 0, inst.z), base: new THREE.Vector3(inst.x, 0, inst.z), fx: new THREE.Vector3(),
    giro: 0, giroObj: 0, escala: escalaVisual(inst),
    actividad: 0, ladeo: new THREE.Vector2(), mezcla: null, disolucion: null, reviviendo: null,
  };
  gema.grupo.scale.setScalar(p.escala);
  textoEtiqueta(p);
  piezas.set(p.id, p);
  audio.ponerInstrumento(inst);
  golpearGema(gema, 0.8); // al acoplarse, la pieza rebota
  if (inst.disolucion) empezarDisolucion(p, inst.disolucion.duracion, inst.disolucion.restante ?? inst.disolucion.duracion, inst.disolucion.motivo);
  return p;
}

// --- Disolución en polvo de estrella (la decide el servidor) ---
function empezarDisolucion(p, duracion, restante = duracion, motivo) {
  p.disolucion = { desde: performance.now() / 1000 - (duracion - restante), duracion };
  p.reviviendo = null;
  audio.fundir(p.id, restante, motivo); // el sonido se apaga mientras se disuelve (en el final, solo el directo)
  if (seleccion === p && !esMia(p)) seleccionar(null);
}
function revivirPieza(p) {
  if (!p.disolucion) return;
  p.reviviendo = { desde: performance.now() / 1000, p0: progresoDisolucion(p) };
  p.disolucion = null;
  audio.revivir(p.id, 1.2);
  golpearGema(p.gema, 0.6);
}
function progresoDisolucion(p, ahora = performance.now() / 1000) {
  if (p.disolucion) return Math.min((ahora - p.disolucion.desde) / p.disolucion.duracion, 1);
  if (p.reviviendo) return Math.max(p.reviviendo.p0 * (1 - (ahora - p.reviviendo.desde) / 1.2), 0); // las partículas vuelven en 1,2 s
  return 0;
}

// Datos nuevos del servidor (patrón, parámetros, pasos…) → audio y editor.
function actualizarDatos(p, inst) {
  p.inst = inst;
  audio.ponerInstrumento(inst);
  if (editor && seleccion === p) editor.refrescar();
  if (seleccion === p) textoRastreo = '';
}

// polvoFlotante: al final de la obra el polvo de la gema se queda flotando en la escena
function quitarPieza(id, polvoFlotante = false) {
  const p = piezas.get(id);
  if (!p) return;
  if (seleccion === p) seleccionar(null);
  if (agarre?.pieza === p) { agarre = null; controls.enabled = true; }
  if (polvoFlotante) { disolverGema(p.gema, 1); soltarPolvo(p.gema); }
  destruirGema(p.gema);
  p.etiqueta.remove();
  piezas.delete(id);
  audio.quitarInstrumento(id);
  edicionesPendientes.delete(id);
}

// Reemplaza todo lo local por el estado completo (al unirse y al reconectar).
function sincronizar(estado) {
  sala.tempo = estado.tempo;
  sala.escala = estado.escala;
  sala.tripulantes = new Map(estado.tripulantes.map((t) => [t.id, t]));
  if (estado.ajustes) sala.ajustes = estado.ajustes;
  fijarObra(estado.obra || 'abierta', false);
  const vivos = new Set(estado.instrumentos.map((i) => i.id));
  for (const id of [...piezas.keys()]) if (!vivos.has(id)) quitarPieza(id);
  for (const inst of estado.instrumentos) agregarPieza(inst);
  for (const p of piezas.values()) { textoEtiqueta(p); colorearGema(p.gema, colorDe(p.dueno)); }
  refrescarTelemetria();
}

// =====================================================================
// RED — Socket.IO
// =====================================================================
const socket = io(API_URL, { autoConnect: false });

// Envía un evento y espera la respuesta del servidor (con un límite de 5 s).
function pedir(evento, datos) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(evento, datos, (err, r) => resolve(err ? { ok: false, error: 'Sin respuesta del servidor' } : r));
  });
}
function avisarError(r) {
  if (!r.ok) registrar('Error · ' + r.error);
  return r.ok;
}

const elEnlace = document.getElementById('enlace');
function enlace(estado, texto) {
  elEnlace.className = estado;
  elEnlace.textContent = texto;
}

socket.on('connect', async () => {
  enlace('vivo', 'Enlace · en línea');
  const r = await pedir('unirse', {});
  if (!avisarError(r)) return;
  yo = r.tu;
  sincronizar(r.estado);
  document.documentElement.style.setProperty('--mio', yo.color);
  document.getElementById('mi-indicativo').textContent = yo.indicativo;
  refrescarAcople();
  registrar(yo.indicativo + ' a bordo');
});

socket.on('disconnect', () => {
  // Al caer el enlace el servidor elimina nuestras piezas; al volver nos da un indicativo nuevo.
  yo = null;
  enlace('caido', 'Enlace · perdido, reintentando');
  botonesAcople.forEach((b) => (b.disabled = true));
  registrar('Enlace perdido');
});
socket.on('connect_error', () => enlace('caido', 'Enlace · sin señal de ' + API_URL.replace(/^https?:\/\//, '')));

socket.on('tripulante:unido', (t) => {
  sala.tripulantes.set(t.id, t);
  refrescarTelemetria();
  for (const p of piezas.values()) if (p.dueno === t.id) textoEtiqueta(p);
  registrar(t.indicativo + ' a bordo');
});
socket.on('tripulante:salio', ({ id, instrumentosEliminados }) => {
  const nombre = indicativoDe(id);
  instrumentosEliminados.forEach(quitarPieza);
  sala.tripulantes.delete(id);
  refrescarTelemetria();
  registrar(nombre + ' fuera de la estación');
});

socket.on('instrumento:agregado', (inst) => {
  if (piezas.has(inst.id)) return;
  agregarPieza(inst);
  registrar(MODULOS[inst.tipo] + ' creada · ' + indicativoDe(inst.dueno));
});
socket.on('instrumento:movido', ({ id, x, z }) => piezas.get(id)?.destino.set(x, 0, z));
// Física del servidor (~30 por segundo): cada pieza que se movió, [id, x, z]. Se interpola al dibujar.
socket.on('fisica', (lista) => {
  for (const [id, x, z] of lista) {
    const p = piezas.get(id);
    if (p && agarre?.pieza !== p) p.destino.set(x, 0, z); // la que arrastro la manda mi puntero
  }
});
// Choque: rebote de gelatina en las dos gemas y un acento musical de cada instrumento.
socket.on('choque', ({ a, b, fuerza }) => {
  for (const id of [a, b]) {
    const p = piezas.get(id);
    if (!p) continue;
    golpearGema(p.gema, 0.4 + 0.6 * fuerza);
    p.giroObj = Math.min(p.giroObj + 0.8 * fuerza, 4);
    audio.acento(id, fuerza);
  }
});
socket.on('instrumento:disolviendo', ({ id, duracion, motivo }) => {
  const p = piezas.get(id);
  if (!p) return;
  empezarDisolucion(p, duracion, duracion, motivo);
  if (motivo !== 'final') registrar(MODULOS[p.tipo] + ' se disuelve' + (motivo === 'limite' ? ' · límite de 3' : '') + (esMia(p) ? ' · tócala para revivirla' : ''));
});
socket.on('instrumento:revive', ({ id }) => {
  const p = piezas.get(id);
  if (!p) return;
  revivirPieza(p);
  registrar(MODULOS[p.tipo] + ' revive');
});
socket.on('instrumento:eliminado', ({ id, motivo }) => {
  const p = piezas.get(id);
  if (!p) return;
  if (motivo !== 'final') registrar(MODULOS[p.tipo] + (motivo ? ' disuelta' : ' eliminada') + ' · ' + indicativoDe(p.dueno));
  quitarPieza(id, motivo === 'final');
});
// Patrones, pasos y parámetros: llegan completos y el audio los usa desde el siguiente paso.
// El servidor devuelve cada edición a todos, también a quien la hizo. Si en mi pieza hay cambios
// recientes (o por enviar), esa respuesta trae valores un poco más viejos: no deben pisar lo que estoy
// moviendo (antes el deslizador saltaba hacia atrás bajo el dedo y el sonido volvía un instante).
socket.on('instrumento:editado', (inst) => {
  const p = piezas.get(inst.id);
  if (!p) return;
  if (esMia(p) && (edicionesPendientes.has(p.id) || performance.now() - (p.editadaEn || 0) < 600)) {
    const mismaEstructura = inst.pasos === p.inst.pasos && inst.subdivision === p.inst.subdivision;
    p.inst = { ...inst, parametros: { ...inst.parametros, ...p.inst.parametros }, ...(mismaEstructura && { patron: p.inst.patron }) };
    audio.ponerInstrumento(p.inst);
    if (!mismaEstructura && editor && seleccion === p) editor.refrescar();
    return;
  }
  actualizarDatos(p, inst);
});

let avisoTempo = null; // el registro espera a que el tempo deje de moverse
socket.on('tempo:cambiado', ({ tempo, por }) => {
  sala.tempo = tempo;
  refrescarTelemetria();
  clearTimeout(avisoTempo);
  avisoTempo = setTimeout(() => registrar('Tempo ' + tempo + ' BPM · ' + indicativoDe(por)), 600);
});
socket.on('escala:cambiada', ({ escala, por }) => {
  sala.escala = escala;
  refrescarTelemetria();
  registrar('Escala ' + nombreEscala(escala) + ' · ' + indicativoDe(por));
});
socket.on('ajustes:cambiados', (ajustes) => { sala.ajustes = ajustes; refrescarAjustes(); });
// FINAL: el audio hace el "wash" de reverb y delay (audio.iniciarFinal); REABRIR lo deshace
socket.on('obra:final', ({ duracion }) => { audio.iniciarFinal(duracion); fijarObra('finalizando'); registrar('Final de la obra · ' + duracion + ' s'); });
socket.on('obra:cerrada', () => { fijarObra('cerrada'); registrar('Estación cerrada'); });
socket.on('obra:reabierta', () => { audio.reabrirFinal(); fijarObra('abierta'); registrar('Estación reabierta'); });

// =====================================================================
// HUD y CONSOLA — telemetría real, tempo, escala y acople de módulos
// =====================================================================
const elBpm = document.getElementById('t-bpm');
const elEscala = document.getElementById('t-escala');
const elTripulantes = document.getElementById('t-tripulantes');
const elTempo = document.getElementById('c-tempo');
let tocandoTempo = false;

// Tonalidad (12 notas) y modo: se cambian por separado; la escala es la combinación de los dos.
// Es global (cambia para todos) y los patrones se reinterpretan solos (guardan grados).
function botonEscala(contenedor, texto, cambio) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'boton';
  b.textContent = b.title = texto;
  b.addEventListener('click', async () => avisarError(await pedir('escala:cambiar', cambio)));
  document.getElementById(contenedor).appendChild(b);
  return b;
}
const botonesEscala = [
  ...TONALIDADES.map((t) => ({ b: botonEscala('c-tonalidad', nombreNota(t), { tonica: t }), activo: (e) => e.tonica === t })),
  ...MODOS.map(([k, , texto]) => ({ b: botonEscala('c-modo', texto, { modo: k }), activo: (e) => e.modo === k })),
];

function refrescarTelemetria() {
  audio.fijarTempo(sala.tempo);   // el Transport sigue al tempo del servidor en vivo
  audio.fijarEscala(sala.escala); // los patrones guardan grados: se reinterpretan en la escala nueva
  elBpm.textContent = Math.round(sala.tempo);
  elEscala.textContent = nombreEscala(sala.escala);
  elTripulantes.textContent = dosCifras(sala.tripulantes.size);
  if (!tocandoTempo) elTempo.value = sala.tempo;
  for (const { b, activo } of botonesEscala) b.classList.toggle('activo', activo(sala.escala));
}

// Tempo: mientras se arrastra se envía unas 8 veces por segundo; al soltar, el valor final.
let ultimoTempo = 0;
function enviarTempo() {
  ultimoTempo = performance.now();
  pedir('tempo:cambiar', { tempo: Number(elTempo.value) }).then(avisarError);
}
elTempo.addEventListener('pointerdown', () => (tocandoTempo = true));
window.addEventListener('pointerup', () => (tocandoTempo = false));
elTempo.addEventListener('input', () => {
  elBpm.textContent = elTempo.value;
  if (performance.now() - ultimoTempo > 120) enviarTempo();
});
elTempo.addEventListener('change', enviarTempo);

// Acoplar módulo: busca un lugar libre cerca del centro y pide al servidor crear el instrumento.
function lugarLibre() {
  const otras = [...piezas.values()].map((p) => p.destino);
  let mejor = null, mejorDist = -1;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 4.5;
    const c = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    const d = Math.min(Infinity, ...otras.map((o) => o.distanceTo(c)));
    if (d > 1.8) return c;
    if (d > mejorDist) { mejor = c; mejorDist = d; }
  }
  return mejor;
}
const NACIMIENTO = { armonia: { pasos: 16, subdivision: 'corchea' }, melodia: { pasos: 32, subdivision: 'semicorchea' } };
const ultimoPatron = {};
function patronNuevo(tipo) {
  let patron;
  for (let i = 0; i < 20; i++) { // nunca igual al anterior de ese tipo
    patron = patronAleatorio({ tipo, ...NACIMIENTO[tipo], parametros: {} });
    if (JSON.stringify(patron) !== ultimoPatron[tipo]) break;
  }
  ultimoPatron[tipo] = JSON.stringify(patron);
  return patron;
}
const botonesAcople = [...document.querySelectorAll('#acople .boton')];
const elTituloAcople = document.querySelector('#acople .tit');
function refrescarAcople() {
  const abierta = sala.obra === 'abierta';
  botonesAcople.forEach((b) => (b.disabled = !yo || !abierta));
  elTituloAcople.textContent = abierta ? 'Módulo' : sala.obra === 'finalizando' ? 'Final de la obra' : 'Estación cerrada';
  document.body.dataset.obra = sala.obra;
}
botonesAcople.forEach((b) => {
  b.disabled = true;
  b.addEventListener('click', async () => {
    const lugar = lugarLibre();
    const datos = { tipo: b.dataset.tipo, x: +lugar.x.toFixed(2), z: +lugar.z.toFixed(2) };
    // armonía y melodía nacen con una secuencia al azar (el mismo azar musical del botón ALEATORIO),
    // distinta cada vez; la percusión conserva su patrón inicial
    if (NACIMIENTO[datos.tipo]) Object.assign(datos, NACIMIENTO[datos.tipo], { patron: patronNuevo(datos.tipo) });
    const r = await pedir('instrumento:agregar', datos);
    if (!avisarError(r)) return;
    seleccionar(agregarPieza(r.instrumento));
  });
});

// Desacoplar: solo las piezas propias.
async function desacoplar(p) {
  if (!p || !esMia(p)) return;
  avisarError(await pedir('instrumento:eliminar', { id: p.id }));
}
document.getElementById('rastreo-borrar').addEventListener('click', () => desacoplar(seleccion));
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  if (escribiendo(ev.target)) return;
  if (seleccion && esMia(seleccion)) { ev.preventDefault(); desacoplar(seleccion); }
});

// Recentrar: la tecla C lleva la cámara a la vista frontal inicial.
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'c' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
  if (escribiendo(ev.target)) return;
  recentrar();
});

// =====================================================================
// ESTADOS DE LA INTERFAZ (tecla H): Módulos (por defecto) → Todo (director) → Nada
//  · modulos: bloque de creación, gemas con su etiqueta y el panel de la pieza seleccionada
//  · todo:    además título, telemetría, tempo, escala, ESCUCHAR, registro, ayuda, marcas y parlantes 5.1
//  · nada:    solo las figuras en el espacio
// =====================================================================
const ESTADOS = ['modulos', 'todo', 'nada'];
// anillos del radar: no en "Nada"; con la estación cerrada, solo el director (Todo) los ve
const actualizarReferencia = () => { referencia.visible = interfaz !== 'nada' && (sala.obra !== 'cerrada' || interfaz === 'todo'); };
const NOMBRE_ESTADO = { modulos: 'Módulos', todo: 'Todo', nada: 'Nada' };
let interfaz = 'modulos';
function fijarInterfaz(estado) {
  interfaz = estado;
  document.body.dataset.interfaz = estado;
  actualizarReferencia();
  anillo.visible = !!seleccion && estado !== 'nada';
  refrescarParlantes();
  registrar('Interfaz · ' + NOMBRE_ESTADO[estado]);
}
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'h' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
  if (escribiendo(ev.target)) return;
  fijarInterfaz(ESTADOS[(ESTADOS.indexOf(interfaz) + 1) % ESTADOS.length]);
});

// =====================================================================
// AUDIO — el sonido sale solo del computador del director (el del domo).
// Todos empiezan en silencio: con el primer toque se enciende el motor sin sonar, solo para que las
// gemas reaccionen a las notas. ESCUCHAR / SILENCIAR solo aparece en el estado "Todo".
// =====================================================================
// Primer toque, clic o tecla: enciende el motor (los navegadores exigen un gesto) en silencio.
const primerGesto = () => {
  for (const ev of ['pointerup', 'keydown']) window.removeEventListener(ev, primerGesto, true);
  encenderAudio();
};
for (const ev of ['pointerup', 'keydown']) window.addEventListener(ev, primerGesto, true);
const elAudio = document.getElementById('b-audio');
function pintarBotonAudio() {
  const sonando = audio.audioIniciado() && !audio.silenciado();
  elAudio.textContent = sonando ? 'Silenciar' : 'Escuchar';
  elAudio.classList.toggle('sonando', sonando);
}
// Enciende el audio (lo usan el botón ESCUCHAR y el panel de salida, tecla A)
let encendido = null;
function encenderAudio() {
  encendido ||= audio.iniciarAudio().then(() => {
    registrar('Motor de audio en línea · ' + salida.FRECUENCIA / 1000 + ' kHz' + (audio.silenciado() ? ' · en silencio' : ''));
    pintarBotonAudio();
  });
  return encendido;
}
elAudio.addEventListener('click', async () => {
  if (!audio.audioIniciado() || encendido === null) {
    await encenderAudio();
    audio.silenciar(false); // ESCUCHAR: este computador suena
    registrar('Audio en línea');
  } else {
    audio.silenciar(!audio.silenciado()); // después solo silencia lo que escucha esta persona
    registrar(audio.silenciado() ? 'Audio en silencio' : 'Audio en línea');
  }
  pintarBotonAudio();
});

// Fuerza del pulso RGB por sonido: el kick marca el pulso; hat y perc apenas lo rozan.
const PULSO_RGB = { kick: 0.8, snare: 0.5, hat: 0.12, perc: 0.2 };
// Cada paso de cada instrumento llega aquí, sincronizado con el audio.
// Vigilante del audio: si un módulo quedó roto (NaN, silencio cuando debía sonar o errores) se
// reconstruye solo; se anota en el registro de misión.
audio.fijarAvisoVigilante((id, tipo, motivo) => registrar(tipo ? MODULOS[tipo] + ' reconstruida · ' + motivo : 'Audio · ' + motivo));

audio.fijarReaccion((id, paso, sono, tipo) => {
  const p = piezas.get(id);
  if (!p) return;
  if (editor && seleccion === p) editor.marcarPaso(paso);
  if (!sono) return;
  if (tipo === 'percusion') {
    golpearGema(p.gema, 0.5);
    pulsoRGB(PULSO_RGB[p.inst.parametros.sonido] ?? 0.3); // cada golpe dispara el desplazamiento RGB
  } else {
    golpearGema(p.gema, 0.3);
  }
  // cada nota empuja el giro (lo modulan ataque y release, ver animar) y ladea la gema
  p.giroObj = Math.min(p.giroObj + tiemposGiro(p.inst).impulso, 4);
  p.actividad = Math.min(p.actividad + 1, 14);
  const amplitud = 0.08 * Math.min(p.actividad, 8);
  p.ladeo.set((Math.random() - 0.5) * amplitud, (Math.random() - 0.5) * amplitud);
});

// Fantasmas de la reverb (halo que respira) y del delay (una copia por eco), sincronizados con el audio.
audio.fijarFantasmas((id, tipo, fuerza) => {
  const p = piezas.get(id);
  // en el final de la obra (wash) los fantasmas siguen mientras las gemas se disuelven en polvo
  if (!p || (p.disolucion && sala.obra !== 'finalizando')) return;
  lanzarFantasma(tipo, p.gema, colorDe(p.dueno), fuerza, p.tipo);
});

// =====================================================================
// EDICIÓN de instrumentos propios
// Los parámetros y el patrón se aplican al instante en local (se oyen sin esperar)
// y se envían al servidor como mucho 10 veces por segundo.
// =====================================================================
const edicionesPendientes = new Map(); // id → cambios por enviar
let ultimaEdicion = 0;
function enviarEdiciones() {
  ultimaEdicion = performance.now();
  for (const [id, cambios] of edicionesPendientes) {
    pedir('instrumento:editar', { id, ...cambios }).then(avisarError);
  }
  edicionesPendientes.clear();
}
function editarPropia(p, cambios, final) {
  p.editadaEn = performance.now();
  if (cambios.patron) p.inst.patron = cambios.patron;
  if (cambios.parametros) p.inst.parametros = { ...p.inst.parametros, ...cambios.parametros };
  audio.ponerInstrumento(p.inst);
  const previos = edicionesPendientes.get(p.id) || {};
  edicionesPendientes.set(p.id, {
    ...previos, ...cambios,
    ...(cambios.parametros && { parametros: { ...previos.parametros, ...cambios.parametros } }),
  });
  if (final || performance.now() - ultimaEdicion > 100) enviarEdiciones();
}

let editor = null;
const elEditor = document.getElementById('rastreo-editor');
function montarEditor(p) {
  editor?.destruir();
  editor = null;
  if (!p || !esMia(p)) return; // las piezas de otros solo muestran su información
  editor = crearEditor(elEditor, () => p.inst, {
    editar: (cambios, final) => editarPropia(p, cambios, final),
    // pasos y subdivisión cambian la estructura: se espera la respuesta del servidor
    estructura: (cambios) => { enviarEdiciones(); pedir('instrumento:editar', { id: p.id, ...cambios }).then(avisarError); },
  });
}

// =====================================================================
// MEZCLA ESPACIAL + SELECCIÓN Y ARRASTRE DE PIEZAS
// =====================================================================
let seleccion = null;

// Posición → sonido: paneo según izquierda/derecha (eje X) y volumen según cercanía al centro.
function calcularMezcla(pos) {
  const paneo = THREE.MathUtils.clamp(pos.x / RADIO_PANEO, -1, 1);
  const volumen = 1 - THREE.MathUtils.clamp(Math.hypot(pos.x, pos.z) / RADIO_UNIVERSO, 0, 1);
  return { paneo: +paneo.toFixed(2), volumen: +volumen.toFixed(2) };
}

// Anillo sutil que marca la pieza seleccionada
const anillo = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos(i / 96 * Math.PI * 2) * 0.95, 0, Math.sin(i / 96 * Math.PI * 2) * 0.95))),
  new THREE.LineBasicMaterial({ color: 0x8890b0, transparent: false, blending: THREE.AdditiveBlending, depthWrite: false })
);
anillo.visible = false;
scene.add(anillo);

function seleccionar(pieza) {
  if (pieza && pieza !== seleccion) registrar(MODULOS[pieza.tipo] + ' seleccionada');
  // tocar un módulo propio cuenta como interacción: reinicia su reloj y lo revive si se disolvía
  if (pieza && esMia(pieza)) pedir('instrumento:tocar', { id: pieza.id }).then(avisarError);
  const cambio = pieza !== seleccion;
  seleccion = pieza;
  anillo.visible = !!pieza && interfaz !== 'nada';
  textoRastreo = '';
  if (cambio) montarEditor(pieza);
}

const raycaster = new THREE.Raycaster();
const puntero = new THREE.Vector2();
const planoArrastre = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // plano horizontal invisible
const puntoPlano = new THREE.Vector3();
let agarre = null; // { pieza, propia, x0, y0, desfase, movida }
let clicVacio = null; // para deseleccionar con un clic en el espacio vacío

function piezaBajoPuntero(ev) {
  puntero.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(puntero, camera);
  const lista = [...piezas.values()];
  const golpe = raycaster.intersectObjects(lista.filter((p) => !p.disolucion).map((p) => p.gema.malla), false)[0];
  if (golpe) return lista.find((p) => p.gema.malla === golpe.object);
  // una gema que se disuelve casi no tiene superficie: se toca su nube de polvo (una esfera alrededor)
  let mejor = null, distMejor = Infinity;
  for (const p of lista) {
    if (!p.disolucion) continue;
    const d = raycaster.ray.distanceSqToPoint(p.gema.grupo.position);
    if (d < 1.1 * p.escala && d < distMejor) { mejor = p; distMejor = d; }
  }
  return mejor;
}

// Envío de la posición mientras se arrastra: como mucho 20 veces por segundo.
let ultimoEnvio = 0, envioPendiente = null;
// final: al soltar, para que el servidor la deje quieta donde quedó
function enviarPosicion(p, forzar = false, final = false) {
  if (!forzar && performance.now() - ultimoEnvio < 50) { envioPendiente = p; return; }
  ultimoEnvio = performance.now();
  envioPendiente = null;
  const pos = p.base;
  socket.emit('instrumento:mover', { id: p.id, x: +pos.x.toFixed(3), z: +pos.z.toFixed(3), final }, (r) => {
    if (r && !r.ok) registrar('Error · ' + r.error);
  });
}

// En fase de captura para adelantarse a OrbitControls: si se toca una pieza, la cámara no orbita.
lienzo.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const pieza = piezaBajoPuntero(ev);
  if (!pieza) { clicVacio = { x: ev.clientX, y: ev.clientY }; return; } // espacio vacío → orbitar
  clicVacio = null;
  planoArrastre.constant = 0;
  const desfase = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(planoArrastre, puntoPlano)) desfase.copy(pieza.base).sub(puntoPlano);
  agarre = { pieza, propia: esMia(pieza), x0: ev.clientX, y0: ev.clientY, desfase, movida: false,
    umbral: ev.pointerType === 'touch' ? 10 : 5 }; // con el dedo hay más temblor
  controls.enabled = false;
  lienzo.setPointerCapture(ev.pointerId);
}, { capture: true });

lienzo.addEventListener('pointermove', (ev) => {
  if (!agarre) {
    const p = piezaBajoPuntero(ev);
    lienzo.style.cursor = !p ? CURSOR_RETICULA : esMia(p) ? CURSOR_MODULO : CURSOR_AJENO;
    return;
  }
  if (!agarre.propia) return; // las piezas de otros solo se pueden seleccionar
  if (!agarre.movida && Math.hypot(ev.clientX - agarre.x0, ev.clientY - agarre.y0) < agarre.umbral) return;
  agarre.movida = true;
  lienzo.style.cursor = CURSOR_MODULO;
  piezaBajoPuntero(ev); // actualiza el rayo
  if (!raycaster.ray.intersectPlane(planoArrastre, puntoPlano)) return;
  puntoPlano.add(agarre.desfase);
  const d = Math.hypot(puntoPlano.x, puntoPlano.z);
  if (d > RADIO_UNIVERSO) puntoPlano.multiplyScalar(RADIO_UNIVERSO / d); // no salir del universo
  const p = agarre.pieza;
  p.base.set(puntoPlano.x, 0, puntoPlano.z);
  p.destino.copy(p.base);
  enviarPosicion(p);
});

function soltar(ev) {
  if (!agarre) {
    // clic sin arrastrar en el vacío → quitar la selección
    if (clicVacio && ev && Math.hypot(ev.clientX - clicVacio.x, ev.clientY - clicVacio.y) < 10) seleccionar(null);
    clicVacio = null;
    return;
  }
  seleccionar(agarre.pieza); // clic sin mover → solo selecciona
  if (agarre.movida) {
    golpearGema(agarre.pieza.gema); // al soltar tras arrastrar → rebote de gelatina
    enviarPosicion(agarre.pieza, true, true);
    const pos = agarre.pieza.base;
    registrar(MODULOS[agarre.pieza.tipo] + ' reubicada · X ' + coord(pos.x) + ' Z ' + coord(pos.z));
  }
  agarre = null;
  controls.enabled = true;
  lienzo.style.cursor = CURSOR_RETICULA;
}
lienzo.addEventListener('pointerup', soltar);
lienzo.addEventListener('pointercancel', soltar);
lienzo.style.cursor = CURSOR_RETICULA;

// =====================================================================
// HUD en la escena — etiqueta de rastreo y etiquetas bajo cada gema
// =====================================================================
const elRastreo = document.getElementById('rastreo');
const elRastreoDatos = document.getElementById('rastreo-datos');
const elRastreoBorrar = document.getElementById('rastreo-borrar');
const elLinea = document.getElementById('r-linea');
const elPunto = document.getElementById('r-punto');
const elCapaLinea = document.getElementById('rastreo-linea');
const enPantalla = new THREE.Vector3();
let textoRastreo = '';
// En pantallas angostas (celular) el panel de edición es una hoja fija abajo, sin línea a la pieza.
const pantallaAngosta = window.matchMedia('(max-width: 760px)');
function actualizarRastreo() {
  const visible = !!seleccion;
  elRastreo.hidden = !visible;
  elCapaLinea.style.display = visible ? '' : 'none';
  if (document.body.classList.contains('con-panel') !== visible) { document.body.classList.toggle('con-panel', visible); pedirAcomodo(); }
  if (!visible) return;
  // solo el nombre del módulo (el resto se ve en el editor, si la pieza es propia)
  const texto = '<h2>' + MODULOS[seleccion.tipo] + '</h2>';
  if (texto !== textoRastreo) {
    elRastreoDatos.innerHTML = texto;
    textoRastreo = texto;
    elRastreoBorrar.hidden = !esMia(seleccion);
  }
  const acento = colorDe(seleccion.dueno);
  elRastreo.style.setProperty('--acento', acento);
  elCapaLinea.style.setProperty('--acento', acento);
  if (pantallaAngosta.matches) { elCapaLinea.style.display = 'none'; return; } // hoja fija abajo (CSS)
  // El panel queda fijo a la derecha (CSS); la línea une, en cada cuadro, el borde del panel con la
  // gema seleccionada, aunque la gema se mueva (giro del Espacio, phaser o choques).
  const pos = seleccion.gema.grupo.position;
  enPantalla.copy(pos).project(camera);
  if (enPantalla.z > 1) { elCapaLinea.style.display = 'none'; return; } // detrás de la cámara
  const W = window.innerWidth, H = window.innerHeight;
  const sx = (enPantalla.x * 0.5 + 0.5) * W, sy = (-enPantalla.y * 0.5 + 0.5) * H;
  const caja = elRastreo.getBoundingClientRect();
  const lx = caja.left, ay = caja.top + 22; // a la altura del nombre del módulo
  elLinea.setAttribute('points', (sx + 5).toFixed(1) + ',' + (sy - 5).toFixed(1) + ' ' + (lx - 26).toFixed(1) + ',' + ay.toFixed(1) + ' ' + lx.toFixed(1) + ',' + ay.toFixed(1));
  elPunto.setAttribute('cx', sx.toFixed(1));
  elPunto.setAttribute('cy', sy.toFixed(1));
}
// el panel fijo recibe el puntero (clics, desplazamiento propio) y no deja pasar el arrastre a la cámara
elRastreo.style.pointerEvents = 'auto';

// Acomodo del HUD: nada se encima. Mide lo que de verdad ocupa cada bloque (cambia con la tecla H, el
// tamaño de la pantalla, el indicador REC o los registros) y lo pasa al CSS como variables:
//  --alto-pie     espacio que ocupa la franja de abajo (registro · módulos · ayuda): los paneles terminan antes
//  --sup-der      dónde empieza el panel de edición fijo (debajo de ESCUCHAR y REC si se ven)
//  --ancho-mision ancho libre para los controles del director (a la derecha queda el panel de edición)
//  --sup-domo     dónde empieza el panel A en "Todo" (debajo de los controles del director, si cabe)
const elMision = document.getElementById('mision'), elIdentidad = document.getElementById('identidad');
const elPie = document.getElementById('pie');
const seVe = (el) => el.getClientRects().length > 0 && el.offsetHeight > 0;
let acomodoPendiente = false;
function acomodarHud() {
  acomodoPendiente = false;
  const H = window.innerHeight, W = window.innerWidth, css = document.body.style, angosta = pantallaAngosta.matches;
  const pie = seVe(elPie) ? H - elPie.getBoundingClientRect().top + 12 : 18;
  const identidad = seVe(elIdentidad) ? elIdentidad.getBoundingClientRect() : null;
  css.setProperty('--alto-pie', Math.round(pie) + 'px');
  css.setProperty('--sup-der', (identidad && !angosta ? Math.round(identidad.bottom + 12) : 16) + 'px');
  css.setProperty('--alto-identidad', (identidad && angosta ? Math.round(identidad.height + 12) : 0) + 'px');
  const reservaDerecha = 16 + 304 + 18; // el panel de edición fijo (aunque no esté abierto, para que nada salte)
  css.setProperty('--ancho-mision', Math.max(240, W - 22 - Math.max(reservaDerecha, (identidad ? identidad.width + 40 : 0))) + 'px');
  let supDomo = 18;
  if (seVe(elMision)) {
    const fin = elMision.getBoundingClientRect().bottom + 12;
    if (H - fin - pie > 280) supDomo = fin; // si no cabe debajo, el panel A se abre encima (es temporal)
  }
  css.setProperty('--sup-domo', Math.round(supDomo) + 'px');
  elMision.classList.toggle('desborda', elMision.scrollHeight > elMision.clientHeight + 1);
}
function pedirAcomodo() {
  if (acomodoPendiente) return;
  acomodoPendiente = true;
  requestAnimationFrame(acomodarHud);
  setTimeout(() => acomodoPendiente && acomodarHud(), 120); // por si la pestaña no está dibujando
}
const observador = new ResizeObserver(pedirAcomodo);
[elMision, elIdentidad, elPie].forEach((el) => observador.observe(el));
window.addEventListener('resize', pedirAcomodo);

// Etiquetas fijas debajo de cada gema, marcas I / D del paneo y, en 5.1, los parlantes del domo
const bajoPieza = new THREE.Vector3();
const elMarcas = { I: document.getElementById('marca-i'), D: document.getElementById('marca-d') };
const elParlantes = Object.fromEntries(Object.keys(POS_PARLANTES).map((id) => {
  const el = document.createElement('div');
  el.className = 'marca-parlante' + (id === 'C' ? ' centro' : '');
  el.textContent = id;
  el.hidden = true;
  elHud.appendChild(el);
  return [id, el];
}));
function actualizarEtiquetas() {
  const W = window.innerWidth, H = window.innerHeight;
  for (const id in elParlantes) {
    const el = elParlantes[id];
    if (el.hidden) continue;
    bajoPieza.copy(POS_PARLANTES[id]).project(camera);
    el.style.display = bajoPieza.z > 1 ? 'none' : '';
    el.style.transform = 'translate(' + Math.round((bajoPieza.x * 0.5 + 0.5) * W) + 'px,' + Math.round((-bajoPieza.y * 0.5 + 0.5) * H) + 'px) translate(-50%, -50%)';
  }
  for (const lado in elMarcas) {
    bajoPieza.copy(MARCAS_PANEO[lado]).project(camera);
    elMarcas[lado].style.display = bajoPieza.z > 1 ? 'none' : '';
    elMarcas[lado].style.transform = 'translate(' + Math.round((bajoPieza.x * 0.5 + 0.5) * W) + 'px,' + Math.round((-bajoPieza.y * 0.5 + 0.5) * H) + 'px) translate(-50%, -50%)';
  }
  for (const p of piezas.values()) {
    bajoPieza.copy(p.gema.grupo.position); bajoPieza.y -= 1.0;
    bajoPieza.project(camera);
    p.etiqueta.style.display = bajoPieza.z > 1 ? 'none' : '';
    p.etiqueta.style.transform = 'translate(' + Math.round((bajoPieza.x * 0.5 + 0.5) * W) + 'px,' + Math.round((-bajoPieza.y * 0.5 + 0.5) * H) + 'px) translateX(-50%)';
  }
}

// =====================================================================
// PANEL DE AJUSTES (tecla H)
// =====================================================================
function ajustarTamano() {
  ajustarTamanoEscena();
  actualizarEscalaNubes();
}
window.addEventListener('resize', ajustarTamano);

const { gui, info, refrescar: refrescarPanel } = crearPanel({
  ajustarTamano,
  imprimirPiezas() {
    const posiciones = {};
    for (const p of piezas.values()) {
      const pos = p.gema.grupo.position;
      posiciones[p.id] = { tipo: p.tipo, dueno: indicativoDe(p.dueno), x: +pos.x.toFixed(2), z: +pos.z.toFixed(2), ...calcularMezcla(pos) };
    }
    return posiciones;
  },
  golpe() {
    for (const p of seleccion ? [seleccion] : piezas.values()) golpearGema(p.gema);
    pulsoRGB();
    registrar('Golpe · ' + (seleccion ? MODULOS[seleccion.tipo] : 'todos los módulos'));
  },
});

// =====================================================================
// DIRECTOR (estado "Todo") — vida de los módulos, final de la obra y grabación
// =====================================================================
const AJUSTES = [['inactividad', 'c-inactividad', 'v-inactividad'], ['disolucion', 'c-disolucion', 'v-disolucion'], ['final', 'c-final', 'v-final']];
function refrescarAjustes() {
  for (const [clave, idEntrada, idValor] of AJUSTES) {
    const entrada = document.getElementById(idEntrada);
    if (document.activeElement !== entrada) entrada.value = sala.ajustes[clave];
    document.getElementById(idValor).textContent = sala.ajustes[clave] + ' s';
  }
}
for (const [clave, idEntrada, idValor] of AJUSTES) {
  const entrada = document.getElementById(idEntrada);
  entrada.addEventListener('input', () => (document.getElementById(idValor).textContent = entrada.value + ' s'));
  entrada.addEventListener('change', async () => {
    const r = await pedir('ajustes:cambiar', { [clave]: +entrada.value });
    if (avisarError(r)) registrar('Ajuste · ' + clave + ' ' + entrada.value + ' s');
  });
}
refrescarAjustes();

// Estado de la obra: abierta → (FINAL) finalizando → cerrada → (REABRIR) abierta
const elFinal = document.getElementById('b-final'), elReabrir = document.getElementById('b-reabrir');
function fijarObra(estado, avisar = true) {
  const antes = sala.obra;
  sala.obra = estado;
  if (estado === 'abierta' && antes !== 'abierta') apagarPolvoSuelto(); // al reabrir, el polvo se apaga
  if (estado === 'finalizando' && seleccion) seleccionar(null);
  actualizarReferencia();
  elFinal.disabled = estado !== 'abierta';
  elReabrir.disabled = estado !== 'cerrada';
  pintarFinal();
  refrescarAcople();
  if (avisar) refrescarTelemetria();
}
// FINAL: pide confirmación (dos clics) o mantener F pulsada 2 s, para evitar accidentes.
let confirmarFinal = 0, finalTecla = null;
function pintarFinal(extra = '') {
  elFinal.textContent = extra || (performance.now() < confirmarFinal ? '¿Confirmar final?' : 'Final · F');
  elFinal.classList.toggle('alerta', !!extra || performance.now() < confirmarFinal);
}
async function lanzarFinal() {
  confirmarFinal = 0;
  avisarError(await pedir('obra:final', {}));
  pintarFinal();
}
elFinal.addEventListener('click', () => {
  if (performance.now() < confirmarFinal) { lanzarFinal(); return; }
  confirmarFinal = performance.now() + 4000;
  pintarFinal();
  setTimeout(pintarFinal, 4100);
});
elReabrir.addEventListener('click', async () => avisarError(await pedir('obra:reabrir', {})));
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'f' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || escribiendo(ev.target)) return;
  if (sala.obra !== 'abierta' || finalTecla) return;
  const desde = performance.now();
  registrar('Mantén F 2 s para el final');
  finalTecla = setInterval(() => {
    const falta = 2 - (performance.now() - desde) / 1000;
    if (falta > 0) { pintarFinal('Final en ' + falta.toFixed(1) + ' s'); return; }
    clearInterval(finalTecla);
    finalTecla = null;
    lanzarFinal();
  }, 50);
});
window.addEventListener('keyup', (ev) => {
  if (ev.key.toLowerCase() !== 'f' || !finalTecla) return;
  clearInterval(finalTecla);
  finalTecla = null;
  pintarFinal();
  registrar('Final cancelado');
});

// Grabación (tecla R): solo con el audio activo; si no hay carpeta, la pide.
const elRec = document.getElementById('rec'), elRecTiempo = document.getElementById('rec-tiempo');
const reloj3 = (s) => dosCifras(s / 3600) + ':' + dosCifras((s / 60) % 60) + ':' + dosCifras(s % 60);
function actualizarRec() {
  const g = grabacion.info();
  elRec.hidden = !g.grabando && !g.exportando;
  elRec.classList.toggle('grabando', g.grabando);
  elRecTiempo.textContent = g.grabando ? reloj3(Math.floor(g.segundos)) : g.exportando;
}
window.addEventListener('keydown', async (ev) => {
  if (ev.key.toLowerCase() !== 'r' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || escribiendo(ev.target)) return;
  if (!audio.audioIniciado()) { registrar('Grabación · activa el audio primero'); return; }
  try {
    const grabando = grabacion.info().grabando;
    if (!grabando) {
      if (await grabacion.iniciar()) registrar('● REC · grabando en ' + grabacion.nombreCarpeta());
    } else {
      registrar('Grabación detenida · copiando a la carpeta');
      const r = await grabacion.detener();
      const e = grabacion.info().error;
      registrar(e ? 'Error · ' + e : 'Grabación guardada · ' + reloj3(Math.round(r.segundos)) + ' · 7 archivos');
    }
  } catch (err) {
    if (err.name !== 'AbortError') registrar('Error · ' + err.message); // AbortError = canceló la carpeta
  }
});

// =====================================================================
// SALIDA · DOMO (tecla A) — dispositivo, prueba de canales y modo estéreo / 5.1 (local)
// =====================================================================
crearDomo({ activar: encenderAudio, registrar, grabacion });
// Modo 5.1 en uso (si el audio aún no está encendido, el que está elegido)
const en51 = () => { const e = salida.estado(); return e.activo ? e.modo === '5.1' : salida.ajustes.modo === '5.1'; };
// El radar muestra los parlantes solo en modo 5.1 y en el estado "Todo", girados según la orientación
function refrescarParlantes() {
  const visible = en51() && interfaz === 'todo';
  const acimuts = Object.fromEntries(salida.ANILLO.map((id) => [id, salida.acimutParlante(id)]));
  actualizarParlantes(visible, acimuts, salida.ajustes.radioCentro);
  for (const id in elParlantes) elParlantes[id].hidden = !visible;
  textoRastreo = '';
}
salida.alCambiar(refrescarParlantes);
refrescarParlantes();

// =====================================================================
// Animación
// =====================================================================
const reloj = new THREE.Clock();
let tiempo = 0;
const fxObjetivo = new THREE.Vector3();
function animar() {
  const dt = Math.min(reloj.getDelta(), 0.1);
  tiempo += dt;
  const rot = params.general.rotacion;
  const suavizado = 1 - Math.exp(-dt * 18); // interpola hacia la posición que manda la física del servidor
  const calma = Math.exp(-dt / 1.2);        // la actividad se apaga en un par de segundos sin notas
  const ladeoSuave = 1 - Math.exp(-dt * 4);
  const fxSuave = 1 - Math.exp(-dt * 16);
  const escalaSuave = 1 - Math.exp(-dt * 5);
  const ahora = performance.now() / 1000;
  const pulsos = audio.pulsos();
  for (const p of piezas.values()) {
    const g = p.gema;
    // Lo visual sigue al valor modulado por los LFO (mismo reloj que el audio): filtro → gelatina,
    // amplitud (env) y golpe → giro. El giro de "Espacio" ya viene en la posición del servidor.
    const m = modulados(p.inst, pulsos);
    const vista = { tipo: p.tipo, id: p.id, parametros: m };
    // Giro: cada nota suma un impulso; el ataque decide qué tan rápido arranca y el release (o el
    // golpe en la percusión) cuánto se prolonga. Sin notas gira lento para que se lea la silueta.
    const t = tiemposGiro(vista);
    p.giroObj *= Math.exp(-dt / t.release);
    p.giro += (p.giroObj - p.giro) * (1 - Math.exp(-dt / t.ataque));
    g.giro.rotation.y += dt * rot * (0.25 + p.semilla * 0.1) * (1 + 0.55 * p.giro);
    // ladeo por actividad (notas recientes)
    p.actividad *= calma;
    p.ladeo.multiplyScalar(calma);
    g.giro.rotation.x += (p.ladeo.x - g.giro.rotation.x) * ladeoSuave;
    g.giro.rotation.z += (Math.sin(tiempo * 0.3 + p.semilla * 6.28) * 0.07 + p.ladeo.y - g.giro.rotation.z) * ladeoSuave;
    // posición: la de la física (o la del puntero si la arrastro) + un pequeño movimiento por FX
    if (agarre?.pieza !== p) p.base.lerp(p.destino, suavizado);
    const quieta = agarre?.pieza === p || !!p.disolucion;
    if (quieta) fxObjetivo.set(0, 0, 0);
    else {
      desplazamientoFx(vista, p.semilla, tiempo, pulsos, fxObjetivo); // órbita del phaser
    }
    p.fx.lerp(fxObjetivo, fxSuave);
    g.grupo.position.copy(p.base).add(p.fx);
    // tamaño por voicing, tono u octava
    p.escala += (escalaVisual(vista) - p.escala) * escalaSuave;
    g.grupo.scale.setScalar(p.escala);
    // disolución en polvo de estrella (o vuelta a la gema al revivir)
    disolverGema(g, progresoDisolucion(p, ahora));
    if (p.reviviendo && ahora - p.reviviendo.desde > 1.2) p.reviviendo = null;
    animarGema(g, p.tipo, dt, gelatinaDe(vista)); // el filtro (también modulado) cambia la gelatina
    // phaser: halo gelatinoso al ritmo de su barrido (0 = sin halo)
    const prm = p.inst.parametros;
    fantasmasPhaser(g, colorDe(p.dueno), prm.fx === 'phaser' && !p.disolucion ? prm.cantidad ?? 0 : 0, pulsos);
    // posición → mezcla (estéreo o 5.1): se actualiza en vivo, también al arrastrar y con el FX
    const pos = g.grupo.position;
    if (!p.mezcla || Math.abs(pos.x - p.mezcla.x) > 0.005 || Math.abs(pos.z - p.mezcla.z) > 0.005) {
      p.mezcla = { x: pos.x, z: pos.z };
      audio.posicionar(p.id, pos.x, pos.z);
    }
  }
  animarPolvoSuelto(dt);
  audio.atenderVisuales(); // rebotes y fantasmas a tiempo con el sonido
  animarFantasmas(dt);
  editor?.latir(pulsos);
  actualizarRec();
  if (edicionesPendientes.size && performance.now() - ultimaEdicion > 100) enviarEdiciones();
  if (envioPendiente) enviarPosicion(envioPendiente);
  if (seleccion) {
    const pos = seleccion.gema.grupo.position;
    anillo.position.copy(pos);
    const m = calcularMezcla(pos);
    info.pieza = MODULOS[seleccion.tipo] + ' · ' + TALLAS[seleccion.tipo];
    info.tripulante = indicativoDe(seleccion.dueno);
    info.x = pos.x; info.z = pos.z; info.paneo = m.paneo; info.volumen = m.volumen;
  }
  actualizarEtiquetas();
  actualizarRastreo();
  actualizarTelemetria();
  dibujar(dt, tiempo);
}

// =====================================================================
// Arranque: primero las gemas, después la conexión con el servidor
// =====================================================================
registrar('Estación 01 en línea');
aplicarVidrio();
cargarPlantillas()
  .then(() => {
    aplicarVidrio(); // con los valores guardados en materiales.json, si los hay
    refrescarPanel();
    renderer.setAnimationLoop(animar);
    enlace('', 'Enlace · conectando con ' + API_URL.replace(/^https?:\/\//, ''));
    socket.connect();
  })
  .catch((e) => {
    const el = document.getElementById('error');
    el.style.display = 'grid';
    el.textContent = 'No se pudieron cargar los modelos. (' + e.message + ')';
    console.error(e);
  });

// Prueba de estrés del audio (solo para probar, solo con npm run dev): http://localhost:5173/?estres=5
// y un clic. Ver src/estres.js. En la versión publicada no existe (no se pueden lanzar tripulantes de
// prueba contra el servidor de la instalación).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('estres')) import('./estres.js').then((m) => { window.__correrEstres = m.correr; });
