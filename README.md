# Polvo de Estrella · frontend

Interfaz de **Polvo de Estrella** (la carpeta local del proyecto se llama OnlineBandApp), una app web de creación musical colectiva en tiempo real pensada como instalación interactiva para el domo del Planetario de Bogotá. Cada persona entra desde su celular o computador como tripulante y crea módulos (percusión, armonía y melodía), que se ven como gemas de vidrio metálico flotando en el espacio exterior, con estética de fotografía de los 80 y un HUD aeroespacial. El sonido sale solo del computador del director (el del domo, en 5.1).

Hecho con Vite, Three.js, Socket.IO y Tone.js. Cada navegador genera la mezcla completa a partir del estado compartido: no se transmite audio. Necesita el servidor [polvo-de-estrella-backend](https://github.com/ouiea-studio/polvo-de-estrella-backend). Publicado en https://polvo-de-estrella.onrender.com.

## Correrlo en local

Necesitas Node.js 20 o más reciente y el backend encendido en http://localhost:3000.

```bash
npm install
npm run dev
```

Abre http://localhost:5173 en dos ventanas para ver la sincronización entre tripulantes.

Para generar la versión publicable: `npm run build` (queda en `dist/`).

## Variables de entorno

| Variable | Para qué sirve | Por defecto |
| --- | --- | --- |
| `VITE_API_URL` | URL del backend. En Render, la URL del Web Service. | `http://localhost:3000` |

Hay un ejemplo en `.env.example`. Como es una variable de Vite, se lee al construir: si cambia, hay que volver a hacer `npm run build`.

## Cómo se usa

Tripulantes (celular o computador):
- **Percusión, Armonía, Melodía** (abajo, al centro): crear un módulo; llega con un patrón que suena de inmediato.
- **Tocar o hacer clic en una pieza propia**: abre su panel de edición (en el celular, una hoja abajo): pasos, ALEATORIO, figura (corchea, semicorchea o tresillo), cuadrícula de notas, los controles del instrumento Amplitud (Env) de corto a largo, LFO junto a Filtro y Amplitud en armonía y melodía (forma de onda y un solo deslizador de profundidad y velocidad al tempo; la percusión no tiene LFO), FX (cada módulo nace con uno al azar y poca cantidad; reverb y delay con sus fantasmas, phaser con su órbita y un halo gelatinoso) y Espacio (la gema gira alrededor de su lugar y el sonido gira por la sala).
- **Arrastrar** una pieza propia: moverla. El volumen depende de su distancia al centro y el lugar en el domo, de su posición.
- **Eliminar** (o **Supr**): quitar la pieza seleccionada. Tocar el espacio vacío cierra el panel.
- Los dispositivos de los tripulantes no suenan: el motor de audio corre en silencio para que las gemas reaccionen a las notas.
- Armonía y melodía nacen con una secuencia al azar, distinta cada vez.
- Si un módulo pasa 45 s sin que su dueño lo toque, se disuelve en polvo de estrella; tocarlo a tiempo lo revive. Máximo 3 módulos vivos por dispositivo. Las gemas chocan y suenan al chocar.

Director (teclado):
- **H**: rota la interfaz entre *Módulos* (por defecto), *Todo* (título, telemetría, tempo, tonalidad y modo, ESCUCHAR, registro y ayuda) y *Nada* (solo las figuras).
- **ESCUCHAR / SILENCIAR** (estado *Todo*): hace sonar este computador.
- **A**: panel SALIDA · DOMO (dispositivo, prueba de canales, estéreo o 5.1, carpeta de grabación).
- **R**: grabar / detener (6 WAV mono del 5.1 + 1 binaural, 48 kHz / 24 bits). **F** (mantener 2 s) o **FINAL**: final de la obra; **REABRIR** la vuelve a abrir.
- El final es un "wash": durante el fundido (20 s por defecto) el sonido directo se apaga, los envíos a una reverb larga del final y al delay suben (el feedback del delay hasta 0,7), desde la mitad no hay notas nuevas y los fantasmas se intensifican mientras las gemas se vuelven polvo; las colas suenan unos 8 s más y luego la salida queda en silencio total. Igual en estéreo, en 5.1 y en la grabación.
- Controles de vida de los módulos (estado *Todo*): segundos sin interacción antes de disolverse, duración de la disolución y del final.
- **V**: panel de ajustes visuales. **C**: recentrar la cámara.
- **D** (o `?vista=domo` en la dirección): vista domo, solo en ese dispositivo. Dibuja un *dome master* (ojo de pez equidistante de 180°, frente abajo) para el proyector del domo; resolución, elevación mínima, tamaño, rotación y espejo en el panel V. **T**: carta de ajuste. **Shift+D**: simulador de la cúpula, que se recorre arrastrando.
- Los atajos no actúan mientras se escribe en un campo de texto.

## Ajustes visuales

Todos los valores por defecto (material, nubes, gelatina, postproducción) están en `public/ajustes.json`. Se puede editar a mano y basta con recargar. Con `npm run dev`, el botón **Guardar material** del panel escribe ahí el material actual.

## Archivos

- `src/main.js`: conexión con el servidor, estado de la sala e interacción.
- `src/audio.js`: sonido con Tone.js (Transport, escalas, instrumentos, voicings, filtro, phaser y niveles).
- `src/salida.js`: salida de audio (dispositivo, estéreo o 5.1, limitador enlazado, prueba de canales).
- `src/domo.js`: panel SALIDA · DOMO (tecla A). `src/limitador.worklet.js`: limitador multicanal.
- `src/editor.js`: panel de edición de cada módulo.
- `src/vigilante.worklet.js`: vigilante de cada módulo (limpia NaN y mide su salida; audio.js reconstruye el módulo si se rompe).
- `src/estres.js`: prueba de estrés del audio, solo con `npm run dev`: abre http://localhost:5173/?estres=5 y haz un clic.
- `src/cupula.js`: vista domo (cubo + ojo de pez, carta de ajuste y simulador). `src/reloj.js`: reloj compartido con el servidor (todos los dispositivos en fase).
- `src/lfo.js`: LFO (ondas sobre el reloj del tempo). `src/envolvente.js`: el macro Amplitud (Env). `src/movimiento.js`: cómo cada parámetro mueve la gema. `src/fantasmas.js`: fantasmas de la reverb, del delay y del phaser. `src/grabacion.js`, `src/grabador.worklet.js` y `src/grabador.worker.js`: grabación (tecla R).
- `src/azar.js`: patrones aleatorios con criterio musical (botón ALEATORIO).
- `src/escena.js`: render, cámara, luces, entornos de reflejo y postproducción.
- `src/gemas.js`: material de vidrio, movimiento gelatinoso y nube interior.
- `src/hud.js` y `src/estilo.css`: HUD y telemetría.
- `src/panel.js`: panel de ajustes (lil-gui).
- `public/assets/`: modelos `.glb` de las gemas y `materiales.json` (datos de Blender).
