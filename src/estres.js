// PRUEBA DE ESTRÉS DEL AUDIO (10 de noviembre de 2026). Solo para probar, no la usa la obra.
// Con el audio encendido en esta ventana, desde la consola del navegador:
//   (await import('/src/estres.js')).correr({ minutos: 5 })
// o abriendo http://localhost:5173/?estres=5 y haciendo un clic (para encender el audio).
//
// Qué hace: conecta 3 tripulantes de prueba (con su propia conexión al servidor) y cada uno crea una
// percusión, una armonía y una melodía (9 módulos). Durante los minutos pedidos, unas 20 veces por
// segundo cambia algo al azar: cualquier deslizador, los LFO y sus formas, el FX y su cantidad, el
// tipo de percusión, la octava, los pasos y la figura, el patrón, la posición (para que choquen), y cada
// pocos segundos la tonalidad, el modo y el tempo. Además, a veces mete valores rotos (NaN, infinito,
// negativos, enormes) directo en el motor de audio, sin pasar por el servidor, y en dos momentos
// estropea a propósito la cadena de un módulo (NaN y desconexión) para comprobar el vigilante.
// Cada 2 s comprueba, por módulo, que su salida sea válida (sin NaN) y audible (pico > −80 dBFS) si
// tocó notas en ese tramo. Al final devuelve un informe (y lo guarda en window.__estres).

import { io } from 'socket.io-client';
import * as audio from './audio.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const azar = (a, b) => a + Math.random() * (b - a);
const uno = (lista) => lista[Math.floor(Math.random() * lista.length)];
const pedir = (s, ev, datos) => new Promise((r) => s.emit(ev, datos, r));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const FORMAS = ['seno', 'azar', 'sierra'];
const NUMEROS = {
  percusion: { pitch: [-12, 12], decay: [0.02, 1.5], cantidad: [0, 1], espacio: [-100, 100] },
  armonia: { voicing: [0, 1], filtro: [0, 1], envolvente: [0, 1], cantidad: [0, 1], lfoFiltro: [0, 1], lfoEnv: [0, 1], espacio: [-100, 100] },
  melodia: { octava: [-1, 1], filtro: [0, 1], envolvente: [0, 1], cantidad: [0, 1], lfoFiltro: [0, 1], lfoEnv: [0, 1], espacio: [-100, 100] },
};
const ROTOS = [NaN, Infinity, -Infinity, -5, 1e9, undefined, null, 'abc'];
const TONICAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODOS = ['jonico', 'dorico', 'frigio', 'lidio', 'mixolidio', 'eolico', 'locrio', 'pentatonica_mayor', 'pentatonica_menor'];

function patronAzar(tipo, pasos) {
  return Array.from({ length: pasos }, () => (tipo === 'percusion' ? Math.random() < 0.4 : Math.random() < 0.55 ? Math.floor(Math.random() * 7) : null));
}

export async function correr({ minutos = 5, accionesPorSegundo = 20 } = {}) {
  if (!audio.audioIniciado()) throw new Error('Primero enciende el audio (un clic en la página)');
  const avisos = [];
  const ow = console.warn, oe = console.error;
  console.warn = (...a) => { avisos.push('aviso: ' + a.join(' ').slice(0, 90)); ow(...a); };
  console.error = (...a) => { avisos.push('error: ' + a.join(' ').slice(0, 90)); oe(...a); };
  const alError = (e) => avisos.push('excepción: ' + String(e.message || e.reason).slice(0, 90));
  window.addEventListener('error', alError);
  window.addEventListener('unhandledrejection', alError);

  // 3 tripulantes de prueba con 3 módulos cada uno
  const bots = [];
  for (let k = 0; k < 3; k++) {
    const s = io(API_URL, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await pedir(s, 'unirse', {});
    const mods = [];
    for (const tipo of ['percusion', 'armonia', 'melodia']) {
      const a = azar(0, Math.PI * 2), d = azar(2, 8);
      const r = await pedir(s, 'instrumento:agregar', { tipo, x: Math.cos(a) * d, z: Math.sin(a) * d });
      if (r.ok) mods.push(r.instrumento);
    }
    bots.push({ s, mods });
  }
  const todos = () => bots.flatMap((b) => b.mods.map((m) => ({ b, m })));
  bots.forEach((b) => b.s.on('instrumento:editado', (inst) => { const m = b.mods.find((x) => x.id === inst.id); if (m) Object.assign(m, inst); }));
  // si un módulo de prueba empieza a disolverse (no debería: se edita seguido) se anota y se revive
  const eventos = [];
  bots.forEach((b) => {
    b.s.on('instrumento:disolviendo', (d) => { if (b.mods.some((m) => m.id === d.id)) { eventos.push('disolviendo ' + d.id + ' (' + d.motivo + ')'); pedir(b.s, 'instrumento:tocar', { id: d.id }); } });
    b.s.on('instrumento:eliminado', (d) => { if (b.mods.some((m) => m.id === d.id)) eventos.push('eliminado ' + d.id + ' (' + d.motivo + ')'); });
    b.s.on('disconnect', (razon) => eventos.push('tripulante de prueba desconectado: ' + razon));
  });

  const informe = { minutos, acciones: 0, porTipo: {}, inyeccionesRotas: 0, ventanas: 0, ventanasConNotas: 0, mudas: [], invalidas: [], sabotajes: [] };
  const contar = (k) => { informe.porTipo[k] = (informe.porTipo[k] || 0) + 1; informe.acciones++; };
  const fin = performance.now() + minutos * 60000, inicio = performance.now();
  audio.medirVentana();

  // comprobación cada 2 s
  const revisar = setInterval(() => {
    const v = audio.medirVentana();
    for (const { m } of todos()) {
      const x = v[m.id];
      if (!x) continue;
      informe.ventanas++;
      if (x.malas > 0 && !saboteados.has(m.id)) informe.invalidas.push({ id: m.id, tipo: m.tipo, t: Math.round((performance.now() - inicio) / 1000), malas: x.malas });
      if (x.notas > 0 && !x.fundido) {
        informe.ventanasConNotas++;
        if (x.pico < 1e-4) informe.mudas.push({ id: m.id, tipo: m.tipo, t: Math.round((performance.now() - inicio) / 1000), pico: x.pico, notas: x.notas });
      }
    }
  }, 2000);

  // sabotajes: al 25 % y al 60 % del tiempo, uno con NaN y otro desconectando un nodo
  const saboteados = new Set(); // la salida inválida de un sabotaje es a propósito: no cuenta como fallo
  const sabotear = async (como) => {
    const { m } = uno(todos());
    saboteados.add(m.id);
    setTimeout(() => saboteados.delete(m.id), 4500);
    const antes = audio.estadoVigilante().find((e) => e.id === m.id)?.reconstrucciones || 0;
    const t0 = performance.now();
    audio._estropear(m.id, como);
    let ms = null;
    while (performance.now() - t0 < 5000) {
      await espera(20);
      if ((audio.estadoVigilante().find((e) => e.id === m.id)?.reconstrucciones || 0) > antes) { ms = Math.round(performance.now() - t0); break; }
    }
    informe.sabotajes.push({ como, id: m.id, tipo: m.tipo, reconstruidoEnMs: ms });
  };
  const sabotajes = [
    setTimeout(() => sabotear('nan'), minutos * 60000 * 0.25),
    setTimeout(() => sabotear('silencio'), minutos * 60000 * 0.6),
  ];

  let ultimoTempo = 0, ultimaEscala = 0;
  while (performance.now() < fin) {
    const ahora = performance.now();
    const { b, m } = uno(todos());
    const r = Math.random();
    window.__trazaEstres?.(m.tipo + ' r=' + r.toFixed(3)); // gancho opcional de depuración
    try {
      if (ahora - ultimoTempo > 2000) {
        ultimoTempo = ahora; contar('tempo');
        pedir(b.s, 'tempo:cambiar', { tempo: Math.round(azar(60, 180)) });
      } else if (ahora - ultimaEscala > 3000) {
        ultimaEscala = ahora; contar('tonalidad y modo');
        pedir(b.s, 'escala:cambiar', Math.random() < 0.5 ? { tonica: uno(TONICAS) } : Math.random() < 0.5 ? { modo: uno(MODOS) } : { tonica: uno(TONICAS), modo: uno(MODOS) });
      } else if (r < 0.5) { // un deslizador cualquiera (incluye los LFO)
        const [k, [a, z]] = uno(Object.entries(NUMEROS[m.tipo]));
        contar(k.startsWith('lfo') ? 'LFO' : 'deslizadores');
        pedir(b.s, 'instrumento:editar', { id: m.id, parametros: { [k]: k === 'octava' || k === 'espacio' ? Math.round(azar(a, z)) : azar(a, z) } });
      } else if (r < 0.6) { // formas de onda
        contar('formas de LFO');
        if (m.tipo !== 'percusion') pedir(b.s, 'instrumento:editar', { id: m.id, parametros: { [uno(['lfoFiltroForma', 'lfoEnvForma'])]: uno(FORMAS) } });
      } else if (r < 0.68) { // efecto
        contar('efectos');
        pedir(b.s, 'instrumento:editar', { id: m.id, parametros: { fx: uno(['reverb', 'delay', 'phaser']), cantidad: Math.random() } });
      } else if (r < 0.73) { // pasos y figura
        contar('pasos y figura');
        pedir(b.s, 'instrumento:editar', { id: m.id, pasos: 1 + Math.floor(Math.random() * 32), subdivision: uno(['corchea', 'semicorchea', 'tresillo']) });
      } else if (r < 0.8) { // patrón
        contar('patrones');
        pedir(b.s, 'instrumento:editar', { id: m.id, patron: patronAzar(m.tipo, m.pasos) });
      } else if (r < 0.84 && m.tipo === 'percusion') {
        contar('tipo de percusión');
        pedir(b.s, 'instrumento:editar', { id: m.id, parametros: { sonido: uno(['kick', 'snare', 'hat', 'perc']) } });
      } else if (r < 0.93) { // moverlo (y que choque con otros)
        contar('movimientos y choques');
        const a = azar(0, Math.PI * 2), d = azar(0, 9);
        pedir(b.s, 'instrumento:mover', { id: m.id, x: Math.cos(a) * d, z: Math.sin(a) * d, final: true });
      } else { // valores rotos directo al motor (sin pasar por el servidor)
        informe.inyeccionesRotas++; contar('valores rotos');
        const k = uno(Object.keys(NUMEROS[m.tipo]).concat(['fx', 'sonido', 'lfoFiltroForma']));
        audio.ponerInstrumento({ ...m, pasos: Math.random() < 0.2 ? uno(ROTOS) : m.pasos, parametros: { ...m.parametros, [k]: uno(ROTOS) } });
        if (Math.random() < 0.3) audio.posicionar(m.id, uno(ROTOS), uno(ROTOS));
        if (Math.random() < 0.2) audio.fijarTempo(uno(ROTOS));
        if (Math.random() < 0.2) audio.fijarEscala({ tonica: uno(ROTOS), modo: uno(ROTOS) });
      }
    } catch (e) { avisos.push('la prueba lanzó: ' + e.message); }
    await espera(1000 / accionesPorSegundo * azar(0.5, 1.5));
  }

  clearInterval(revisar);
  sabotajes.forEach(clearTimeout);
  await espera(2500);
  const vig = audio.estadoVigilante().filter((e) => todos().some(({ m }) => m.id === e.id));
  informe.modulos = vig.map((e) => ({ id: e.id, tipo: e.tipo, notas: e.notas, picoMaxDb: +(20 * Math.log10(e.picoMax || 1e-12)).toFixed(1), reconstrucciones: e.reconstrucciones, motivos: e.motivos, erroresTone: e.errores, contexto: e.contexto }));
  informe.avisos = { total: avisos.length, ejemplos: [...new Set(avisos)].slice(0, 8) };
  informe.eventosDeLaSala = eventos;
  informe.registroDeMision = [...document.querySelectorAll('#registro-lista li')].map((li) => li.textContent);
  informe.duracionSeg = Math.round((performance.now() - inicio) / 1000);
  informe.resultado = informe.invalidas.length === 0 && informe.mudas.length === 0 && informe.avisos.total === 0 && informe.modulos.length === 9 && informe.sabotajes.every((s) => s.reconstruidoEnMs !== null && s.reconstruidoEnMs < 1000)
    ? 'OK: toda la salida válida y audible; los sabotajes se repararon en menos de 1 s'
    : 'REVISAR';

  // limpieza
  for (const b of bots) { for (const m of b.mods) await pedir(b.s, 'instrumento:eliminar', { id: m.id }); b.s.disconnect(); }
  console.warn = ow; console.error = oe;
  window.removeEventListener('error', alError);
  window.removeEventListener('unhandledrejection', alError);
  window.__estres = informe;
  console.log('PRUEBA DE ESTRÉS', informe);
  return informe;
}

// ?estres=5 en la dirección: corre al primer clic (cuando el audio ya está encendido)
const pedido = Number(new URLSearchParams(location.search).get('estres'));
if (pedido > 0) {
  window.addEventListener('pointerup', async function arrancar() {
    window.removeEventListener('pointerup', arrancar);
    await espera(1500);
    correr({ minutos: pedido });
  });
}
