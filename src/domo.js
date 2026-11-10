// Panel SALIDA · DOMO (tecla A; Esc lo cierra). Es local de este computador: no pasa por el servidor.
// Elige el dispositivo de salida, muestra sus datos, prueba los 6 canales del domo con ruido rosa,
// cambia entre estéreo y 5.1 y ajusta la espacialización. Usa el mismo motor de audio que la música
// (salida.js); los ajustes quedan guardados en este navegador.

import * as salida from './salida.js';
import { CANALES, ajustes } from './salida.js';

const SEGUNDOS_RECORRIDO = 2;
const signo = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
// [ruta en los ajustes, etiqueta, mínimo, máximo, paso, formato]
const PARAMS_51 = [
  ['orientacion', 'Orientación', -180, 180, 1, (v) => signo(v) + '°'],
  ['radioCentro', 'Radio al C', 0, 1, 0.01, (v) => Math.round(v * 100) + ' %'],
  ['atenuacionBorde', 'Atenuación borde', -24, 0, 0.5, (v) => signo(v) + ' dB'],
  ['nivelLFE', 'Nivel LFE', -24, 6, 0.5, (v) => signo(v) + ' dB'],
  ...['FL', 'FR', 'RR', 'RL'].map((id) => ['angulos.' + id, 'Ángulo ' + id, -180, 180, 1, (v) => signo(v) + '°']),
];
const leer = (ruta) => ruta.split('.').reduce((o, k) => o[k], ajustes);
const ms = (s) => (typeof s === 'number' ? (s * 1000).toFixed(1) + ' ms' : '—');

const PLANTILLA = `
  <header class="dm-cabeza"><h2>Salida <i>·</i> Domo</h2><button class="boton dm-cerrar" type="button">A · Cerrar</button></header>

  <div class="dm-bloque">
    <div class="tit">Dispositivo de salida</div>
    <select class="dm-select" id="dm-salida"></select>
    <div class="dm-fila">
      <button class="boton" id="dm-permiso" type="button">Mostrar dispositivos</button>
      <button class="boton" id="dm-activar" type="button">Activar audio</button>
    </div>
    <p class="dm-nota" id="dm-nota-permiso">Chrome solo muestra los nombres de las interfaces con permiso de micrófono. No se graba nada: el micrófono se cierra al instante.</p>
    <dl class="dm-datos">
      <div class="dm-ancho"><dt>Dispositivo</dt><dd id="dm-d-disp">—</dd></div>
      <div><dt>Frecuencia</dt><dd id="dm-d-frec">—</dd></div>
      <div><dt>maxChannelCount</dt><dd id="dm-d-max">—</dd></div>
      <div><dt>Destino</dt><dd id="dm-d-canales">—</dd></div>
      <div><dt>Latencia</dt><dd id="dm-d-lat">—</dd></div>
      <div><dt>Limitador</dt><dd id="dm-d-lim">—</dd></div>
    </dl>
    <div class="dm-aviso" id="dm-aviso" hidden></div>
  </div>

  <div class="dm-bloque">
    <div class="tit">Modo de este computador</div>
    <div class="dm-fila">
      <button class="boton dm-modo" data-modo="estereo" type="button">Estéreo</button>
      <button class="boton dm-modo" data-modo="5.1" type="button">5.1</button>
    </div>
    <p class="dm-nota" id="dm-nota-modo"></p>
  </div>

  <div class="dm-bloque">
    <div class="tit">Planta del domo <span class="dm-frente">▲ frente</span></div>
    <div class="dm-planta" id="dm-planta"></div>
    <div class="dm-fila">
      <button class="boton" id="dm-recorrido" type="button">Recorrido 1 → 6</button>
      <button class="boton dm-parar" id="dm-parar" type="button">Parar</button>
    </div>
    <label class="dm-param"><b>Nivel prueba</b><input class="deslizador" id="dm-nivel" type="range" min="-60" max="-14" step="1"><span id="dm-nivel-v"></span></label>
    <div class="dm-sonando"><b>Sonando</b><span id="dm-sonando">—</span></div>
    <div class="dm-barra"><i id="dm-barra"></i></div>
  </div>

  <div class="dm-bloque">
    <div class="tit">Espacialización 5.1</div>
    <div id="dm-params"></div>
    <button class="boton dm-restablecer" id="dm-restablecer" type="button">Valores por defecto</button>
  </div>

  <div class="dm-bloque">
    <div class="tit">Grabación · tecla R</div>
    <div class="dm-fila">
      <button class="boton" id="dm-carpeta" type="button">Carpeta de grabación</button>
      <button class="boton" id="dm-recuperar" type="button" hidden>Recuperar</button>
    </div>
    <p class="dm-nota" id="dm-grab"></p>
  </div>

  <details class="dm-bloque">
    <summary class="tit">Avanzado</summary>
    <div class="dm-fila dm-canales">
      <b>Canales del destino</b>
      <button class="boton" data-canales="6" type="button">6</button>
      <button class="boton" data-canales="8" type="button">8</button>
      <button class="boton" data-canales="16" type="button">16</button>
    </div>
    <p class="dm-nota">Con 6, Chrome podría tratar la salida como “5.1” y reordenar canales. Si el recorrido no sale en el orden esperado, prueba 8 o 16: la app siempre escribe en los canales 1 a 6.</p>
  </details>
`;

// acciones: { activar(): Promise, registrar(texto) }
export function crearDomo(acciones) {
  const raiz = document.createElement('section');
  raiz.id = 'domo';
  raiz.hidden = true;
  raiz.innerHTML = PLANTILLA;
  document.getElementById('hud').appendChild(raiz);
  const $ = (sel) => raiz.querySelector(sel);

  // --- Botones de canal en la planta ---
  const botones = CANALES.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'boton dm-canal dm-pos-' + c.id;
    b.innerHTML = `<span class="dm-id">${c.id}</span><span class="dm-det">${i + 1} · ${c.salida}</span>`
      + '<span class="dm-medidor"><i></i></span><span class="dm-db">—</span>';
    b.title = c.desc;
    b.addEventListener('click', () => {
      if (salida.estado().prueba === i && !recorrido) { parar(); return; }
      detenerRecorrido();
      if (!salida.probarCanal(i)) acciones.registrar('Canal ' + (i + 1) + ' no disponible en este dispositivo');
      else acciones.registrar('Prueba · ' + c.id + ' → canal ' + (i + 1));
    });
    $('#dm-planta').appendChild(b);
    return { b, barra: b.querySelector('.dm-medidor i'), db: b.querySelector('.dm-db') };
  });

  // --- Recorrido 1 → 6 ---
  let recorrido = null; // { timer, inicio }
  function detenerRecorrido() {
    if (!recorrido) return;
    clearTimeout(recorrido.timer);
    recorrido = null;
  }
  function parar() {
    const habia = salida.estado().prueba !== null || recorrido;
    detenerRecorrido();
    salida.pararPrueba();
    if (habia) acciones.registrar('Prueba detenida');
  }
  function iniciarRecorrido() {
    detenerRecorrido();
    const r = { timer: null, inicio: 0, paso: 0 };
    recorrido = r;
    acciones.registrar('Recorrido de prueba · 6 × ' + SEGUNDOS_RECORRIDO + ' s');
    const paso = (i) => {
      if (recorrido !== r) return;
      if (i >= CANALES.length) { recorrido = null; salida.pararPrueba(); acciones.registrar('Recorrido terminado'); return; }
      r.paso = i;
      r.inicio = performance.now();
      salida.probarCanal(i);
      r.timer = setTimeout(() => paso(i + 1), SEGUNDOS_RECORRIDO * 1000);
    };
    paso(0);
  }
  $('#dm-recorrido').addEventListener('click', iniciarRecorrido);
  $('#dm-parar').addEventListener('click', parar);

  // --- Nivel de la prueba ---
  const nivel = $('#dm-nivel');
  nivel.value = ajustes.nivelPrueba;
  nivel.addEventListener('input', () => salida.fijarAjuste('nivelPrueba', +nivel.value));

  // --- Modo y canales ---
  raiz.querySelectorAll('.dm-modo').forEach((b) => b.addEventListener('click', () => {
    salida.fijarAjuste('modo', b.dataset.modo);
    acciones.registrar('Salida · modo ' + (b.dataset.modo === '5.1' ? '5.1' : 'estéreo'));
  }));
  raiz.querySelectorAll('[data-canales]').forEach((b) => b.addEventListener('click', () => {
    salida.fijarAjuste('canales', +b.dataset.canales);
    acciones.registrar('Salida · destino de ' + b.dataset.canales + ' canales');
  }));

  // --- Parámetros 5.1 ---
  const controles = PARAMS_51.map(([ruta, etiqueta, min, max, paso, formato]) => {
    const fila = document.createElement('label');
    fila.className = 'dm-param';
    fila.innerHTML = `<b>${etiqueta}</b><input class="deslizador" type="range" min="${min}" max="${max}" step="${paso}"><span></span>`;
    const entrada = fila.querySelector('input'), valor = fila.querySelector('span');
    entrada.addEventListener('input', () => salida.fijarAjuste(ruta, +entrada.value));
    entrada.addEventListener('dblclick', () => salida.fijarAjuste(ruta, ruta.split('.').reduce((o, k) => o[k], salida.POR_DEFECTO)));
    $('#dm-params').appendChild(fila);
    return { refrescar: () => {
      const v = leer(ruta);
      if (document.activeElement !== entrada) entrada.value = v;
      valor.textContent = formato(v);
    } };
  });
  $('#dm-restablecer').addEventListener('click', () => { salida.restablecer51(); acciones.registrar('Espacialización 5.1 por defecto'); });

  // --- Dispositivos ---
  const sel = $('#dm-salida');
  async function listar() {
    let todos = [];
    try { todos = await navigator.mediaDevices.enumerateDevices(); } catch { /* sin permiso o sin soporte */ }
    const salidas = todos.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
    const conNombre = salidas.some((d) => d.label);
    sel.replaceChildren(new Option('Salida del sistema', ''));
    for (const d of salidas) if (d.deviceId) sel.add(new Option(d.label || 'Salida sin nombre', d.deviceId));
    // el guardado; si cambió su id, se reconoce por el nombre
    const guardado = ajustes.dispositivo;
    let elegido = salidas.find((d) => d.deviceId === guardado.id);
    if (!elegido && guardado.nombre) elegido = salidas.find((d) => d.label === guardado.nombre);
    sel.value = elegido ? elegido.deviceId : '';
    if (elegido && elegido.deviceId !== guardado.id) salida.elegirDispositivo(elegido.deviceId, elegido.label);
    $('#dm-permiso').hidden = conNombre;
    $('#dm-nota-permiso').hidden = conNombre;
    return conNombre;
  }
  $('#dm-permiso').addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop()); // el micrófono se cierra de inmediato
    } catch (e) {
      acciones.registrar('Permiso negado · no se pueden elegir salidas');
      return;
    }
    acciones.registrar(await listar() ? 'Dispositivos de salida listados' : 'Chrome no dio los nombres de las salidas');
  });
  sel.addEventListener('change', async () => {
    const nombre = sel.value ? sel.options[sel.selectedIndex].textContent : '';
    const ok = await salida.elegirDispositivo(sel.value, nombre);
    acciones.registrar(ok ? 'Salida · ' + (nombre || 'sistema') : 'Error · no se pudo usar ' + nombre);
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', listar);
  $('#dm-activar').addEventListener('click', async () => {
    $('#dm-activar').disabled = true;
    await acciones.activar();
  });

  // --- Grabación: carpeta de destino y recuperación de tomas interrumpidas ---
  const grab = acciones.grabacion;
  let pendientes = [];
  $('#dm-carpeta').addEventListener('click', async () => {
    try { await grab.elegirCarpeta(); acciones.registrar('Carpeta de grabación · ' + grab.nombreCarpeta()); } catch { /* canceló */ }
    refrescar();
  });
  $('#dm-recuperar').addEventListener('click', async () => {
    try {
      const n = await grab.recuperar();
      acciones.registrar(n + ' grabación(es) recuperada(s) en ' + grab.nombreCarpeta());
    } catch (e) { if (e.name !== 'AbortError') acciones.registrar('Error · ' + e.message); }
    pendientes = await grab.pendientes();
    refrescar();
  });
  grab.alCambiar(() => { if (!raiz.hidden) refrescar(); });
  function refrescarGrabacion() {
    const g = grab.info();
    $('#dm-recuperar').hidden = !pendientes.length || g.grabando || !!g.exportando;
    $('#dm-recuperar').textContent = `Recuperar ${pendientes.length} toma(s) interrumpida(s)`;
    $('#dm-grab').textContent = !grab.soportada() ? 'Este navegador no permite grabar a una carpeta: usa Chrome.'
      : g.error ? g.error
      : g.grabando ? '● Grabando 6 canales + binaural · R para detener'
      : g.exportando ? 'Guardando: ' + g.exportando
      : (g.carpeta ? 'Carpeta: ' + g.carpeta : 'Sin carpeta: se pedirá al pulsar R') + ' · 6 WAV mono + 1 binaural, 48 kHz / 24 bits';
  }

  // --- Mostrar el estado ---
  function refrescar() {
    refrescarGrabacion();
    const e = salida.estado();
    $('#dm-activar').disabled = e.activo;
    $('#dm-activar').textContent = e.activo ? 'Audio activo' : 'Activar audio';
    $('#dm-d-disp').textContent = sel.value ? sel.options[sel.selectedIndex]?.textContent : 'Salida del sistema';
    const frec = $('#dm-d-frec');
    frec.textContent = e.frecuencia ? e.frecuencia + ' Hz' : '—';
    frec.className = e.frecuencia ? (e.frecuencia === salida.FRECUENCIA ? 'ok' : 'mal') : '';
    const max = $('#dm-d-max');
    max.textContent = e.maxCanales ?? '—';
    max.className = e.maxCanales ? (e.maxCanales >= 6 ? 'ok' : 'mal') : '';
    $('#dm-d-canales').textContent = e.canales ? e.canales + ' · ' + e.interpretacion : '—';
    const aviso = $('#dm-aviso');
    const texto = e.error || (e.activo && e.maxCanales < 6 && ajustes.modo === '5.1'
      ? `Este dispositivo ofrece ${e.maxCanales} canal(es) a Chrome; el 5.1 necesita 6. Suena en estéreo.` : '');
    aviso.hidden = !texto;
    aviso.textContent = texto;
    raiz.querySelectorAll('.dm-modo').forEach((b) => b.classList.toggle('activo', b.dataset.modo === ajustes.modo));
    raiz.querySelectorAll('[data-canales]').forEach((b) => b.classList.toggle('activo', +b.dataset.canales === ajustes.canales));
    $('#dm-nota-modo').textContent = !e.activo
      ? 'Se aplica al activar el audio. Los demás dispositivos no suenan.'
      : e.modo === '5.1'
        ? 'Cada pieza suena según su ángulo (FL · FR · RR · RL) y, cerca del centro, por el C del cenit.'
        : 'Paneo por X y volumen por distancia, por los canales 1 y 2.';
    $('#dm-nivel-v').textContent = ajustes.nivelPrueba + ' dBFS';
    controles.forEach((c) => c.refrescar());
    botones.forEach(({ b }, i) => {
      b.disabled = !e.activo || (e.canales !== null && i >= e.canales);
      b.classList.toggle('dm-activo', e.prueba === i);
    });
    $('#dm-recorrido').disabled = $('#dm-parar').disabled = !e.activo;
    $('#dm-sonando').textContent = e.prueba === null ? (e.activo ? (salida.silenciado() ? 'música en silencio · ESCUCHAR (tecla H)' : 'música') : '—')
      : CANALES[e.prueba].id + ' · canal ' + (e.prueba + 1) + (recorrido ? ` · recorrido ${recorrido.paso + 1} de 6` : '');
  }
  salida.alCambiar(() => { if (!raiz.hidden) refrescar(); });

  // Cada cuadro, con el panel abierto: medidores, latencia y limitador
  function animar() {
    if (raiz.hidden) return;
    const e = salida.estado();
    const lista = salida.niveles();
    lista.forEach((db, i) => {
      const { barra, db: texto } = botones[i];
      const finito = db !== null && isFinite(db);
      barra.style.width = finito ? Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%' : '0';
      texto.textContent = db === null ? '—' : finito ? db.toFixed(1) : '-∞';
    });
    $('#dm-d-lat').textContent = e.activo ? ms(e.latenciaBase) + ' / ' + ms(e.latenciaSalida) : '—';
    $('#dm-d-lim').textContent = e.activo ? (e.reduccion < -0.05 ? e.reduccion.toFixed(1) + ' dB' : '0 dB') : '—';
    $('#dm-barra').style.width = recorrido ? Math.min(100, (performance.now() - recorrido.inicio) / (SEGUNDOS_RECORRIDO * 10)) + '%' : '0';
    requestAnimationFrame(animar);
  }

  function abrir(si) {
    if (si === !raiz.hidden) return;
    raiz.hidden = !si;
    if (si) { listar().then(refrescar); grab.pendientes().then((l) => { pendientes = l; refrescar(); }); refrescar(); requestAnimationFrame(animar); }
    else parar(); // al cerrar, la señal de prueba se apaga y vuelve la música
  }
  $('.dm-cerrar').addEventListener('click', () => abrir(false));
  // campos donde se escribe (un deslizador no cuenta: con el foco en él, A sigue funcionando)
  const escribiendo = (t) => t.isContentEditable || ['TEXTAREA', 'SELECT'].includes(t.tagName)
    || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type));
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !raiz.hidden) { abrir(false); return; }
    if (ev.key.toLowerCase() !== 'a' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    if (escribiendo(ev.target)) return;
    abrir(raiz.hidden);
  });

  return { abrir, refrescar };
}
