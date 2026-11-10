// Panel de ajustes visuales (lil-gui). Oculto por defecto: se muestra y oculta con la tecla V.

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { params, aplicarPost, PRESETS_VIDRIO } from './escena.js';
import { aplicarVidrio, aplicarNubes, guardarMaterial } from './gemas.js';
import { registrar, escribiendo } from './hud.js';

const NOMBRES = { percusion: 'Percusión', armonia: 'Armonía', melodia: 'Melodía' };

// acciones: { imprimirPiezas(), golpe(), ajustarTamano() }
export function crearPanel(acciones) {
  const gui = new GUI({ title: 'Ajustes visuales · V para ocultar' });
  gui.hide();
  window.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() !== 'v' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    if (escribiendo(ev.target)) return;
    gui.show(gui._hidden);
  });

  gui.add({
    imprimir() {
      const texto = JSON.stringify({ ...params, piezas: acciones.imprimirPiezas() }, null, 2);
      console.log('Valores actuales de OnlineBandApp:\n' + texto);
      navigator.clipboard?.writeText(texto).catch(() => {});
    },
  }, 'imprimir').name('Imprimir valores en consola');
  gui.add({ golpe: acciones.golpe }, 'golpe').name('Golpe (rebote + pulso RGB)');

  // Datos de la pieza seleccionada (solo lectura)
  const info = { pieza: 'ninguna', tripulante: '—', x: 0, z: 0, paneo: 0, volumen: 0 };
  const gInfo = gui.addFolder('Pieza seleccionada');
  gInfo.add(info, 'pieza').listen().disable();
  gInfo.add(info, 'tripulante').listen().disable();
  gInfo.add(info, 'x').name('posición x').decimals(2).listen().disable();
  gInfo.add(info, 'z').name('posición z').decimals(2).listen().disable();
  gInfo.add(info, 'paneo', -1, 1).name('paneo (-1 izq · 1 der)').decimals(2).listen().disable();
  gInfo.add(info, 'volumen', 0, 1).name('volumen (cerca del centro)').decimals(2).listen().disable();

  const gGel = gui.addFolder('Gelatina');
  gGel.add(params.gelatina, 'ondulacion', 0, 0.12, 0.001).name('ondulación');
  gGel.add(params.gelatina, 'velocidad', 0, 4, 0.01).name('velocidad de ondulación');
  gGel.add(params.gelatina, 'rebote', 0, 1.5, 0.01).name('intensidad del rebote');
  gGel.add(params.gelatina, 'rigidez', 40, 500, 1);
  gGel.add(params.gelatina, 'amortiguacion', 1, 25, 0.1).name('amortiguación');

  const gGeneral = gui.addFolder('General');
  gGeneral.add(params.general, 'rotacion', 0, 4, 0.01).name('velocidad de rotación');
  gGeneral.add(params.general, 'resolucion', 0.75, 2, 0.25).name('resolución (rendimiento)').onChange(acciones.ajustarTamano);

  // Vidrio metálico: un preset de partida y todos sus valores afinables.
  const v = params.vidrio;
  const gVidrio = gui.addFolder('Vidrio metálico');
  gVidrio.add(params, 'presetVidrio', Object.keys(PRESETS_VIDRIO)).name('preset').onChange((nombre) => {
    Object.assign(v, PRESETS_VIDRIO[nombre]);
    gVidrio.controllersRecursive().forEach((c) => c.updateDisplay());
    aplicarVidrio();
    registrar('Material · ' + nombre);
  });
  gVidrio.add({
    async guardar() {
      try {
        const destino = await guardarMaterial();
        registrar(destino === 'archivo' ? 'Material guardado en ajustes.json' : 'Material copiado al portapapeles');
      } catch (err) {
        registrar('Error al guardar el material');
        console.error(err);
      }
    },
  }, 'guardar').name('Guardar material');
  const gMetal = gVidrio.addFolder('Metal (brillo y reflejos)').onChange(aplicarVidrio);
  gMetal.add(v, 'entorno', { 'estudio paleta (magenta, cian, dorado)': 'paleta', 'estudio plata': 'plata' }).name('qué refleja');
  gMetal.add(v, 'metalicidad', 0, 0.3, 0.01).name('metalicidad (máx 0.3)');
  gMetal.add(v, 'especular', 0, 1, 0.01).name('intensidad especular');
  gMetal.addColor(v, 'colorEspecular').name('color especular');
  gMetal.add(v, 'clearcoat', 0, 1, 0.01);
  gMetal.add(v, 'rugosidadClearcoat', 0, 0.4, 0.005).name('rugosidad clearcoat');
  gMetal.add(v, 'reflejosEntorno', 0, 6, 0.05).name('reflejos del entorno');
  const gIrid = gVidrio.addFolder('Iridiscencia (viraje de color)').onChange(aplicarVidrio);
  gIrid.add(v, 'iridiscencia', 0, 1, 0.01).name('intensidad');
  gIrid.add(v, 'iorIridiscencia', 1, 2.33, 0.01).name('IOR de la película');
  gIrid.add(v, 'grosorIridMin', 0, 1200, 10).name('grosor mínimo (nm)');
  gIrid.add(v, 'grosorIridMax', 0, 1200, 10).name('grosor máximo (nm)');
  const gTrans = gVidrio.addFolder('Translúcido (cuerpo del vidrio)').onChange(aplicarVidrio);
  gTrans.add(v, 'transmision', 0, 1, 0.01).name('transmisión');
  gTrans.add(v, 'rugosidad', 0, 0.4, 0.005).name('rugosidad (esmerilado)');
  gTrans.addColor(v, 'colorCuerpo').name('color del cuerpo');
  gTrans.add(v, 'tinteBase', 0, 1, 0.01).name('color propio de la gema');
  gTrans.addColor(v, 'colorAtenuacion').name('color interior');
  gTrans.add(v, 'distanciaAtenuacion', 0.1, 6, 0.05).name('distancia del color interior');
  gTrans.add(v, 'grosor', 0, 2, 0.01).name('grosor (refracción)');
  gTrans.add(v, 'ior', 1, 2.33, 0.01).name('índice de refracción (IOR)');
  gTrans.add(v, 'dispersion', 0, 5, 0.01).name('dispersión (fuego)');
  const gLuces = gVidrio.addFolder('Luces').onChange(aplicarVidrio);
  gLuces.add(v, 'lucesColor', 0, 200, 1).name('luces de color');
  gLuces.add(v, 'destellos', 0, 200, 1).name('destellos en bordes');

  const gNubes = gui.addFolder('Nubes').onChange(aplicarNubes);
  gNubes.add(params.nubes, 'tamano', 0.02, 0.3, 0.005).name('tamaño de partícula');
  gNubes.add(params.nubes, 'brillo', 0, 1, 0.005);
  gNubes.add(params.nubes, 'iridiscencia', 0, 1, 0.01);
  for (const clave in NOMBRES) {
    const g = gNubes.addFolder(NOMBRES[clave]);
    g.add(params.nubes[clave], 'densidad', 0, 1, 0.01);
    g.add(params.nubes[clave], 'velocidad', 0, 3, 0.01);
  }

  const gPost = gui.addFolder('Postproducción (años 80)').onChange(aplicarPost);
  const gBloom = gPost.addFolder('Bloom');
  gBloom.add(params.post.bloom, 'intensidad', 0, 2, 0.01);
  gBloom.add(params.post.bloom, 'radio', 0, 1, 0.01);
  gBloom.add(params.post.bloom, 'umbral', 0, 2, 0.01);
  const gEstrella = gPost.addFolder('Filtro estrella');
  gEstrella.add(params.post.estrella, 'intensidad', 0, 3, 0.01);
  gEstrella.add(params.post.estrella, 'largo', 0.3, 2, 0.05);
  gEstrella.add(params.post.estrella, 'umbral', 0, 4, 0.01);
  gEstrella.add(params.post.estrella, 'angulo', 0, 90, 1).name('ángulo');
  gPost.add(params.post, 'grano', 0, 0.3, 0.005).name('grano de película');
  gPost.add(params.post, 'vineta', 0, 1, 0.01).name('viñeta');
  gPost.add(params.post, 'aberracion', 0, 4, 0.05).name('aberración cromática');
  gPost.add(params.post, 'gradacion', 0, 1, 0.01).name('gradación de color');
  gPost.add(params.post, 'estela', 0, 0.97, 0.01).name('estela (obturación lenta)');
  const gRGB = gPost.addFolder('Desplazamiento RGB');
  gRGB.add(params.post.rgb, 'base', 0, 0.01, 0.0001).name('intensidad base');
  gRGB.add(params.post.rgb, 'pulso', 0, 0.05, 0.0005).name('intensidad del pulso');
  gRGB.add(params.post.rgb, 'duracion', 0.05, 3, 0.01).name('duración del pulso (s)');

  // Los demás grupos empiezan cerrados para que el panel no tape la escena.
  for (const g of [gGel, gGeneral, gNubes, gPost, gMetal, gIrid, gTrans, gLuces]) g.close();

  // Para mostrar los valores cargados de materiales.json después de crear el panel.
  const refrescar = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
  return { gui, info, refrescar };
}
