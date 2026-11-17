// Parámetros de la dirección (URL), leídos una sola vez al cargar la página.
// Sirven para abrir Polvo de Estrella como FUENTE DE VIDEO (Resolume, TouchDesigner, OBS…) sin
// teclado ni ratón. Se pueden combinar: ?vista=domo&interfaz=0&rol=espectador
//  · vista=domo       → arranca en la vista fulldome (la misma de la tecla D). Ver cupula.js.
//  · interfaz=0       → arranca con toda la interfaz oculta (el estado "Nada" de la tecla H).
//  · rol=espectador   → solo mira: recibe el estado de la obra y el reloj compartido, no cuenta como
//                       tripulante, no crea módulos y nunca enciende el audio. El lienzo es un
//                       cuadrado (1:1) que llena la ventana (escena.js y cupula.js).
// Sin parámetros, la app funciona exactamente igual que antes.

const q = new URLSearchParams(location.search);

export const VISTA_DOMO = q.get('vista') === 'domo';
export const SIN_INTERFAZ = q.get('interfaz') === '0';
export const ESPECTADOR = q.get('rol') === 'espectador';

if (ESPECTADOR) document.body.dataset.rol = 'espectador';
