// Editor de un instrumento propio: se monta dentro de la etiqueta de rastreo.
// Pensado para músicos y no músicos: nombres cortos, pistas en los extremos de cada deslizador
// (por ejemplo "oscuro ↔ brillante") y sin números técnicos.
// Arriba: pasos, ALEATORIO, subdivisión (íconos de figuras) y la cuadrícula (percusión: una fila de
// golpes; armonía y melodía: 7 filas, una por grado de la escala). Abajo: los controles del
// instrumento (en armonía y melodía, Filtro y Amplitud (Env) llevan su propio LFO; la percusión no tiene LFO: forma y un solo
// deslizador de profundidad y velocidad), el bloque FX y "Espacio" (la gema gira alrededor de su lugar).
// No hay volumen: lo da la distancia al centro.

import { patronAleatorio } from './azar.js';
import { VOICINGS, etapaVoicing } from './audio.js';
import { nombreCiclo, forma as formaLfo } from './lfo.js';

const PASOS_POR_PULSO = { corchea: 2, semicorchea: 4, tresillo: 3, quintillo: 5 };
const GRADOS = 7;

// Figuras musicales dibujadas en SVG (cabeza, plica, corchetes y barra), en currentColor.
const cabeza = (x, y) => `<ellipse cx="${x}" cy="${y}" rx="3.3" ry="2.4" transform="rotate(-24 ${x} ${y})" fill="currentColor"/>`;
const plica = (x, y1, y2) => `<path d="M${x} ${y1}V${y2}" stroke="currentColor" stroke-width="1.3"/>`;
const corchete = (x, y) => `<path d="M${x} ${y}c.4 2.6 4.6 3.6 4 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
const ICONOS = {
  corchea: `<svg viewBox="0 0 20 24" aria-hidden="true">${cabeza(8, 19)}${plica(10.9, 18.3, 3)}${corchete(10.9, 3)}</svg>`,
  semicorchea: `<svg viewBox="0 0 20 24" aria-hidden="true">${cabeza(8, 19)}${plica(10.9, 18.3, 3)}${corchete(10.9, 3)}${corchete(10.9, 7.5)}</svg>`,
  tresillo: `<svg viewBox="0 0 34 26" aria-hidden="true">${[6, 16, 26].map((x) => cabeza(x, 22) + plica(x + 2.9, 21.3, 8)).join('')}`
    + `<path d="M8.9 8H28.9" stroke="currentColor" stroke-width="2.6"/>`
    + `<text x="18.9" y="5" text-anchor="middle" font-size="6.5" font-family="IBM Plex Mono, monospace" fill="currentColor">3</text></svg>`,
};
const SUBDIVISIONES = [['corchea', 'Corchea'], ['semicorchea', 'Semicorchea'], ['tresillo', 'Tresillo de corcheas']];
// Formas de onda del LFO, dibujadas en SVG
const onda = (d) => `<svg viewBox="0 0 28 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const FORMAS = [
  ['seno', onda('M1 7C4 -1 7 -1 10 7S16 15 19 7S24 -1 27 7'), 'Onda sinusoidal: sube y baja suave'],
  ['azar', onda('M1 9H6V3H11V11H16V5H21V8H27'), 'Ruido: un valor al azar nuevo en cada ciclo'],
  ['sierra', onda('M1 12L9 2V12L18 2V12L27 2'), 'Diente de sierra: sube y cae de golpe'],
];

// Controles por tipo.
//   opciones:    { clave, nombre, opciones: [[valor, texto], …] }
//   deslizador:  { clave, nombre, min, max, paso, log, pistas: [izquierda, derecha], valor(v) opcional }
const OPC = (clave, nombre, opciones) => ({ clave, nombre, opciones });
const DES = (clave, nombre, min, max, pistas, extra = {}) => ({ clave, nombre, min, max, pistas, paso: 0.01, ...extra });
// lfo: [clave del valor, clave de la forma] → una fila "LFO" junto al deslizador
const FILTRO = DES('filtro', 'Filtro', 0, 1, ['oscuro', 'brillante'], { lfo: ['lfoFiltro', 'lfoFiltroForma'] });
const ENV = DES('envolvente', 'Amplitud (Env)', 0, 1, ['corto', 'largo'], { lfo: ['lfoEnv', 'lfoEnvForma'] });
const CONTROLES = {
  percusion: [
    OPC('sonido', 'Tipo', [['kick', 'Kick'], ['snare', 'Snare'], ['hat', 'Hat'], ['perc', 'Perc']]),
    DES('pitch', 'Tono', -12, 12, ['grave', 'agudo'], { paso: 1 }),
    DES('decay', 'Golpe', 0.02, 1.5, ['seco', 'largo'], { log: true }),
  ],
  armonia: [
    DES('voicing', 'Voicing', 0, 1, ['cerrado', 'abierto'], { valor: (v) => VOICINGS[etapaVoicing(v)] }),
    FILTRO, ENV,
  ],
  melodia: [
    OPC('octava', 'Octava', [[-1, '−1'], [0, '0'], [1, '+1']]),
    FILTRO, ENV,
  ],
};
const FX = [
  OPC('fx', 'FX', [['reverb', 'Reverb'], ['delay', 'Delay'], ['phaser', 'Phaser']]),
  DES('cantidad', 'Cantidad', 0, 1, ['nada', 'mucho']),
];
// Espacio: −100 a +100; 0 = quieta. El signo decide el sentido del giro alrededor de su lugar.
const ESPACIO = [DES('espacio', 'Giro', -100, 100, ['antihorario', 'horario'], {
  paso: 1, cero: true, valor: (v) => (v === 0 ? 'quieta' : (v > 0 ? '↻ ' : '↺ ') + Math.abs(v)),
})];
// Golpe típico de cada sonido de percusión: se aplica al cambiar de tipo.
const DECAY_PERC = { kick: 0.4, snare: 0.18, hat: 0.05, perc: 0.25 };

const crear = (etiqueta, clase, texto) => {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
};
const boton = (clase, contenido, titulo) => {
  const b = crear('button', 'boton ' + clase);
  b.type = 'button';
  if (contenido.startsWith('<')) b.innerHTML = contenido; else b.textContent = contenido;
  if (titulo) { b.title = titulo; b.setAttribute('aria-label', titulo); }
  return b;
};

// obtener(): datos actuales del instrumento · acciones.editar(cambios, final) · acciones.estructura(cambios)
export function crearEditor(contenedor, obtener, acciones) {
  const raiz = crear('div', 'editor');
  contenedor.replaceChildren(raiz);
  const tipo = obtener().tipo;

  // --- Pasos (− / +), ALEATORIO y subdivisión: cambian la estructura, esperan al servidor ---
  const filaPasos = crear('div', 'ed-fila');
  const menos = boton('ed-mini', '−', 'Menos pasos');
  const mas = boton('ed-mini', '+', 'Más pasos');
  const numPasos = crear('span', 'ed-valor');
  menos.addEventListener('click', () => acciones.estructura({ pasos: Math.max(1, obtener().pasos - 1) }));
  mas.addEventListener('click', () => acciones.estructura({ pasos: Math.min(32, obtener().pasos + 1) }));
  const aleatorio = boton('ed-aleatorio', 'Aleatorio', 'Un patrón nuevo al azar, con criterio musical');
  aleatorio.addEventListener('click', () => {
    acciones.editar({ patron: patronAleatorio(obtener()) }, true);
    pintarRejilla();
  });
  filaPasos.append(crear('b', '', 'Pasos'), menos, numPasos, mas, aleatorio);

  const filaSub = crear('div', 'ed-fila');
  filaSub.append(crear('b', '', 'Figura'));
  const botonesSub = SUBDIVISIONES.map(([valor, nombre]) => {
    const b = boton('ed-figura', ICONOS[valor], nombre);
    b.addEventListener('click', () => acciones.estructura({ subdivision: valor }));
    filaSub.append(b);
    return [valor, b];
  });

  // --- Cuadrícula de pasos ---
  const rejilla = crear('div', 'ed-rejilla');
  let columnas = []; // paso → celdas de esa columna (para el cursor de reproducción)
  let pasoMarcado = -1;
  function construirRejilla() {
    const inst = obtener();
    const filas = inst.tipo === 'percusion' ? 1 : GRADOS;
    rejilla.style.setProperty('--pasos', inst.pasos);
    rejilla.classList.toggle('ed-una-fila', filas === 1);
    rejilla.classList.toggle('ed-muchos', inst.pasos > 16);
    const celdas = [];
    columnas = Array.from({ length: inst.pasos }, () => []);
    const porPulso = PASOS_POR_PULSO[inst.subdivision] || 4;
    for (let f = 0; f < filas; f++) {
      const grado = filas === 1 ? null : GRADOS - 1 - f; // el grado más agudo arriba
      for (let s = 0; s < inst.pasos; s++) {
        const c = crear('div', 'ed-celda' + (s % porPulso === 0 ? ' ed-pulso' : ''));
        c.dataset.paso = s;
        if (grado !== null) c.dataset.grado = grado;
        celdas.push(c);
        columnas[s].push(c);
      }
    }
    rejilla.replaceChildren(...celdas);
    pasoMarcado = -1;
    pintarRejilla();
  }
  function pintarRejilla() {
    const inst = obtener();
    for (const c of rejilla.children) {
      const v = inst.patron[+c.dataset.paso];
      c.classList.toggle('ed-on', c.dataset.grado === undefined ? !!v : v === +c.dataset.grado);
    }
  }
  rejilla.addEventListener('pointerdown', (ev) => {
    const c = ev.target.closest('.ed-celda');
    if (!c) return;
    const patron = [...obtener().patron];
    const s = +c.dataset.paso;
    if (c.dataset.grado === undefined) patron[s] = !patron[s];
    else patron[s] = patron[s] === +c.dataset.grado ? null : +c.dataset.grado;
    acciones.editar({ patron }, true);
    pintarRejilla();
  });

  // --- Controles del instrumento y FX ---
  const controles = []; // { refrescar(parametros) }
  function construirControl(def, destino) {
    const fila = crear('div', 'ed-control');
    const titulo = crear('div', 'ed-titulo');
    const valor = crear('span', 'ed-valor');
    titulo.append(crear('b', '', def.nombre), valor);
    fila.append(titulo);
    if (def.opciones) {
      const grupo = crear('div', 'ed-opciones');
      const botones = def.opciones.map(([v, texto, titulo]) => {
        const b = boton('ed-op' + (texto.startsWith('<') ? ' ed-onda' : ''), texto, titulo);
        b.addEventListener('click', () => {
          const cambio = { [def.clave]: v };
          if (def.clave === 'sonido') cambio.decay = DECAY_PERC[v];
          acciones.editar({ parametros: cambio }, true);
          refrescar();
        });
        grupo.append(b);
        return [v, b];
      });
      fila.append(grupo);
      controles.push({ refrescar: (p) => botones.forEach(([v, b]) => b.classList.toggle('activo', p[def.clave] === v)) });
    } else {
      const entrada = crear('input', 'deslizador');
      entrada.type = 'range';
      entrada.setAttribute('aria-label', def.nombre + ': ' + def.pistas.join(' a '));
      // escala logarítmica para tiempos: el oído los percibe así
      const aEntrada = (v) => (def.log ? 1000 * Math.log(v / def.min) / Math.log(def.max / def.min) : v);
      const deEntrada = (t) => (def.log ? +(def.min * (def.max / def.min) ** (t / 1000)).toFixed(4) : +t);
      Object.assign(entrada, def.log ? { min: 0, max: 1000, step: 1 } : { min: def.min, max: def.max, step: def.paso });
      const enviar = (final) => {
        const v = deEntrada(entrada.value);
        if (def.valor) valor.textContent = def.valor(v);
        acciones.editar({ parametros: { [def.clave]: v } }, final);
      };
      entrada.addEventListener('input', () => enviar(false));
      entrada.addEventListener('change', () => enviar(true));
      const pista = crear('div', 'ed-pista');
      pista.append(crear('span', '', def.pistas[0]), crear('span', '', def.pistas[1]));
      if (def.cero) { // marca visible en el centro (0) del deslizador
        const envoltura = crear('div', 'ed-con-cero');
        envoltura.append(entrada, crear('i', 'ed-cero'));
        fila.append(envoltura, pista);
      } else fila.append(entrada, pista);
      if (def.lfo) construirLfo(def, fila);
      controles.push({
        refrescar: (p) => {
          if (p[def.clave] === undefined) { fila.hidden = true; return; }
          fila.hidden = false;
          if (def.valor) valor.textContent = def.valor(p[def.clave]);
          if (document.activeElement !== entrada) entrada.value = aEntrada(p[def.clave]); // no pisar lo que se arrastra
        },
      });
    }
    destino.append(fila);
  }
  // LFO junto a un parámetro: forma (íconos) y un solo deslizador (0 = apagado; más = más profundo y rápido)
  const latidos = [];
  function construirLfo(def, destino) {
    const [claveValor, claveForma] = def.lfo;
    const fila = crear('div', 'ed-lfo-fila');
    const formas = crear('div', 'ed-formas');
    const botones = FORMAS.map(([v, icono, titulo]) => {
      const b = boton('ed-op ed-onda', icono, 'LFO de ' + def.nombre.toLowerCase() + ': ' + titulo);
      b.addEventListener('click', () => { acciones.editar({ parametros: { [claveForma]: v } }, true); refrescar(); });
      formas.append(b);
      return [v, b];
    });
    const entrada = crear('input', 'deslizador');
    Object.assign(entrada, { type: 'range', min: 0, max: 1, step: 0.01 });
    entrada.setAttribute('aria-label', 'LFO de ' + def.nombre.toLowerCase() + ': apagado a rápido y profundo');
    const valor = crear('span', 'ed-valor');
    const latido = crear('i', 'ed-latido'); // late con el valor actual del LFO
    latido.title = 'Valor actual del LFO';
    latidos.push({ latido, cual: claveValor === 'lfoFiltro' ? 'filtro' : 'env' });
    const texto = (v) => (v > 0 ? nombreCiclo(v) : 'apagado');
    const enviar = (final) => {
      valor.textContent = texto(+entrada.value);
      acciones.editar({ parametros: { [claveValor]: +entrada.value } }, final);
    };
    entrada.addEventListener('input', () => enviar(false));
    entrada.addEventListener('change', () => enviar(true));
    fila.append(crear('b', '', 'LFO'), latido, formas, entrada, valor);
    destino.append(fila);
    controles.push({
      refrescar: (p) => {
        if (p[claveValor] === undefined) { fila.hidden = true; return; }
        fila.hidden = false;
        botones.forEach(([v, b]) => b.classList.toggle('activo', p[claveForma] === v));
        if (document.activeElement !== entrada) entrada.value = p[claveValor];
        valor.textContent = texto(p[claveValor]);
        fila.classList.toggle('ed-lfo-activo', p[claveValor] > 0);
      },
    });
  }
  const bloqueParams = crear('div', 'ed-params');
  CONTROLES[tipo].forEach((def) => construirControl(def, bloqueParams));
  const bloqueFx = crear('div', 'ed-params ed-fx');
  FX.forEach((def) => construirControl(def, bloqueFx));
  const bloqueEspacio = crear('div', 'ed-params ed-espacio');
  bloqueEspacio.append(crear('div', 'ed-seccion', 'Espacio'));
  ESPACIO.forEach((def) => construirControl(def, bloqueEspacio));

  raiz.append(filaPasos, filaSub, rejilla, bloqueParams, bloqueFx, bloqueEspacio);

  let estructura = '';
  function refrescar() {
    const inst = obtener();
    numPasos.textContent = String(inst.pasos).padStart(2, '0');
    botonesSub.forEach(([v, b]) => b.classList.toggle('activo', inst.subdivision === v));
    const nueva = inst.pasos + '/' + inst.subdivision;
    if (nueva !== estructura) { estructura = nueva; construirRejilla(); } else pintarRejilla();
    controles.forEach((c) => c.refrescar(inst.parametros));
  }
  refrescar();

  return {
    refrescar,
    // cursor de reproducción: resalta la columna del paso que está sonando
    marcarPaso(paso) {
      if (pasoMarcado === paso) return;
      columnas[pasoMarcado]?.forEach((c) => c.classList.remove('ed-actual'));
      columnas[paso]?.forEach((c) => c.classList.add('ed-actual'));
      pasoMarcado = paso;
    },
    // cada cuadro: el punto de cada LFO late con su valor actual (mismo reloj que el audio)
    latir(pulsos) {
      const inst = obtener();
      for (const { latido, cual } of latidos) {
        const v = formaLfo(inst, cual, pulsos); // −1 a 1 (0 si está apagado)
        const on = (cual === 'filtro' ? inst.parametros.lfoFiltro : inst.parametros.lfoEnv) > 0;
        const t = (v + 1) / 2;
        latido.style.opacity = on ? (0.25 + 0.75 * t).toFixed(2) : '0.15';
        latido.style.transform = 'scale(' + (on ? 0.55 + 0.75 * t : 0.6).toFixed(2) + ')';
      }
    },
    destruir() { raiz.remove(); },
  };
}
