# liam · ft8d — Discord Community Cloner 3.1.2

Clonador de comunidades con menú en español, encabezado con degradado compacto
para móvil, respaldos previos e informes de cada copia. Requiere Node.js 20.18 o
superior; funciona con Node.js LTS 24 de Termux.

## Actualizar en Termux

Detén la versión anterior con Ctrl+C. Descarga `Discord-Cloner-3.1.2-Termux.zip`
en Descargas y ejecuta:

```sh
cd ~
unzip -o ~/storage/downloads/Discord-Cloner-3.1.2-Termux.zip
cd ~/Discord-Server-Cloner-2x
npm ci
bash start-termux.sh
```

El ZIP no contiene `.env`, respaldos ni informes: al actualizar conserva los
archivos locales. `npm ci` actualiza las dependencias de esta versión.

Para instalar desde cero:

```sh
pkg update && pkg upgrade -y
pkg install nodejs-lts unzip -y
termux-setup-storage
cd ~
unzip ~/storage/downloads/Discord-Cloner-3.1.2-Termux.zip
cd ~/Discord-Server-Cloner-2x
bash start-termux.sh
```

Acepta el permiso de archivos que pide Android. Instala el proyecto en la carpeta
personal de Termux, no en `/sdcard`, donde npm puede fallar por los permisos y
enlaces. El script instala las dependencias la primera vez y solicita un bloqueo
de suspensión cuando Termux lo permite. Mantén la aplicación abierta durante la
copia; si Android la detiene, revisa su optimización de batería.

Para volver a abrirlo:

```sh
cd ~/Discord-Server-Cloner-2x
bash start-termux.sh
```

## Uso

Introduce el token únicamente en tu terminal: se muestra como asteriscos `***`.
Puedes borrarlo con la tecla normal de borrar, editarlo con las flechas o vaciarlo
con Ctrl+U. Las teclas sólo cambian la línea de entrada; no borran el menú. También
puedes configurar `TOKEN=...` en `.env`. No compartas el token ni ese archivo.
Esta versión usa `discord.js-selfbot-v13` y un token de cuenta, no de bot.
Discord prohíbe los selfbots y puede suspender la cuenta; la compatibilidad de la
biblioteca depende de su API.

El menú permite:

1. Copiar a un servidor existente.
2. Crear un servidor nuevo y copiar.
3. Restaurar un respaldo.
4. Ver los respaldos guardados.
0. Salir.

Activa Modo desarrollador en Discord y usa **Copiar ID** para obtener los IDs de
origen y destino. Deben ser distintos para una copia normal. Usa servidores que
tengas autorización para copiar. Para obtener todos los ajustes, la cuenta debe
poder administrarlos en el origen; en el destino se recomienda ser propietario.
Se comprueban permisos, jerarquía y límites de canales y roles antes de borrar.

Después de los IDs, elige el modo de copia:

| Modo | Recursos |
| --- | --- |
| Enter o `1`: Rápido | Canales, categorías, roles, permisos, AutoMod, emojis, stickers y ajustes de Comunidad |
| `2`: Completo sin mensajes | Añade nombres/ajustes de hilos y publicaciones accesibles, y roles de miembros que ya estén en el destino |

**Ningún modo del menú lee ni copia el historial de mensajes.** También se omite
al restaurar un respaldo antiguo que contenga conversaciones. El modo rápido
omite la enumeración de hilos y de todos los miembros, que puede tardar mucho en
comunidades grandes. El modo completo requiere más solicitudes; las publicaciones
de foro necesitan un texto inicial nuevo para poder recrearse, sin copiar su
contenido anterior.

La pantalla muestra la etapa, el elemento actual, el contador y el tiempo
transcurrido. Cuando Discord pide una pausa, muestra su cuenta atrás. Las teclas
que pulses durante una copia se descartan para evitar entradas accidentales en
la siguiente pregunta. El menú permanece visible; la barra sólo actualiza su
línea actual. Los detalles de cada recurso están en el informe, evitando cientos
de líneas repetidas de emojis en pantalla.

Antes de copiar se muestran los recursos encontrados, las omisiones de lectura y
el respaldo previo del destino. **Escribir `CLONAR` reemplaza canales, roles,
emojis, stickers y ajustes disponibles del destino.** Los baneos existentes se
conservan y se añaden los del origen. El respaldo previo no incluye conversaciones.
Los canales obligatorios de Comunidad se
conservan y se reutilizan cuando corresponden al origen: un error 50074 no aborta
la limpieza.

## Qué copia

| Recurso | Alcance |
| --- | --- |
| Roles y permisos | Orden, color, permisos, menciones, visibilidad y restricciones de canales; iconos si el destino los admite |
| Categorías y canales | Texto, anuncios, voz, escenarios, foros y multimedia; posiciones y ajustes disponibles |
| Hilos y publicaciones | Sólo en modo completo: nombres, etiquetas y ajustes accesibles; sin historial |
| Mensajes | Desactivados en el menú, incluidos adjuntos, embeds e historial |
| Emojis | Estáticos y animados, restricciones de roles y referencias en foros y bienvenida |
| Stickers | PNG, APNG y GIF, nombre, descripción y etiqueta; Lottie se omite con explicación |
| AutoMod | Reglas, filtros/regex, acciones, estado y excepciones con IDs del destino; conserva tipos nuevos del JSON de Discord |
| Comunidad | Intenta activarla automáticamente; copia canales de reglas, actualizaciones y alertas |
| Bienvenida e incorporación | Pantalla de bienvenida, preguntas y canales/roles de onboarding, formulario de aceptación de reglas |
| Eventos | Eventos futuros, canales, ubicación y recurrencia compatible |
| Miembros presentes | Roles sólo en modo completo; permisos individuales de canales para usuarios ya presentes |
| Baneos | Usuarios y motivos; no borra mensajes al añadir el baneo |
| Ajustes | Nombre, icono, descripción, idioma, verificación, notificaciones, filtro, canal del sistema, AFK y widget |
| Imágenes del servidor | Banner y fondo de invitación si el destino tiene las funciones requeridas |

Los emojis y stickers se guardan en el respaldo como imágenes base64 cuando es
posible. Los IDs cambian al recrearlos y se remapean las referencias admitidas.
Si falta un rol o canal exento de AutoMod, se omite la regla y se explica el motivo
para evitar aplicarla a más personas. Una regla rechazada no se anuncia como copiada.

La versión 3.1.2 ajusta nombres de roles vacíos, invisibles o demasiado largos
antes de crearlos y registra los cambios en el informe. Los nombres válidos
conservan su estilo. El respaldo conserva los nombres originales; los permisos
se relacionan por el ID de origen, incluso si dos roles tienen el mismo nombre.
Si Discord rechaza específicamente un nombre con el error 50035, se reintenta
una vez con un nombre sencillo. Un error de formulario que siga afectando a un
rol queda registrado y permite continuar con los demás; los fallos de permisos
o conexión interrumpen la operación e identifican el rol afectado. Un rol que no
se creó no se sustituye por otro de igual nombre al copiar los permisos.
Los colores se envían con el formato actual de la biblioteca, evitando el aviso
de la opción `color` obsoleta.

Los escenarios necesitan Comunidad; sin ella se recrean como voz. Los foros se
recrean como texto si no se puede activar Comunidad. Los canales multimedia
pueden pasar a foro si Discord rechaza esa función. Cada cambio se registra.
Se ajusta el bitrate a la capacidad del destino. Los cupos de emojis y stickers,
los boosts y los permisos pueden limitar la importación: el informe identifica
cada elemento rechazado y el error de Discord.

Las imágenes de emojis/stickers se descargan con un máximo de cuatro transferencias
simultáneas y un plazo de 20 segundos por descarga. Las modificaciones en Discord
respetan sus límites y se mantienen secuenciales. Primero se crean los canales;
las imágenes se procesan después, y al final se actualizan los emojis de los foros.

Se anticipan los cupos estáticos/animados de emojis por separado y el cupo de
stickers. Si se agotan, se omiten los restantes de ese tipo sin provocar una cadena
de errores de API. Al repetir una copia se reutilizan emojis con exactamente el
mismo nombre, formato y bytes de imagen. Cuando sus restricciones de roles ya
coinciden, no se hace una solicitud de escritura adicional.

Si Discord pide esperar más de 15 segundos para subir o actualizar un emoji o
sticker, se aplazan los restantes de ese recurso y se continúa con las demás
funciones. El resultado queda **completado con omisiones** y conserva los nombres
pendientes y su motivo en el informe. No hay reintento automático ni un plazo
garantizado para la copia: las esperas de otros recursos y las pausas globales de
Discord se siguen respetando. Repetir la copia tras la pausa puede reutilizar
emojis idénticos que ya se hayan importado.

La versión 3.1.1 corrige una espera de la biblioteca: ante respuestas HTTP 429,
el plazo real puede venir en `Retry-After` o en el JSON `retry_after`, mientras
que el plazo general de la ruta es mucho menor. Ahora se comunica el plazo real
al clonador y a la barra de progreso. Las pausas largas de imágenes se aplazan
antes de crear un temporizador, se libera la cola y se conserva el bloqueo de esa
operación hasta que expire. Las pausas cortas y los límites globales se respetan.
Una respuesta 429 sin plazo utilizable genera una omisión/error, no un bucle.

El parche de `scripts/patch-discord.cjs` se instala automáticamente con `npm ci`
y se verifica antes de `npm start`. La dependencia está fijada en 3.7.1 y el script
rechaza una estructura inesperada en lugar de aplicar cambios a ciegas.

La caché se actualiza tras eliminar imágenes, evitando contar como existentes
emojis/stickers que ya fueron borrados. El error 10068 al leer un formulario de
acceso inexistente se interpreta como formulario desactivado.

## Límites y recursos que no se transfieren

- Miembros, bots, integraciones, propiedad, boosts y beneficios del servidor.
- IDs y fechas originales, autoría real de mensajes, reacciones, conexiones de
  respuestas, auditoría y sesiones de voz. Esta versión del menú no copia mensajes.
- Códigos originales de invitaciones, insignias y elegibilidad de funciones.
- La guía avanzada del servidor (tareas y recursos) y las configuraciones de bots
  guardadas fuera de Discord no se importan en esta versión.
- Historial, y hilos a los que la cuenta no tenga acceso. La captura previa del
  destino conserva estructura y ajustes, no conversaciones.

## Respaldos e informes

Los nuevos respaldos están en `backups/<id>.json`; los informes están en
`reports/copia-<fecha>.json`. El resultado indica si hubo omisiones y su motivo,
y el informe se actualiza durante la operación para conservar lo ocurrido si falla.
Guarda estas carpetas: un respaldo puede contener conversaciones y datos privados.

Para intentar recuperar el destino, elige **3**: primero aparece la lista de
respaldos, ordenada del más reciente al más antiguo, con fecha, servidor y
cantidad de recursos. Elige su número en la lista o introduce el ID del respaldo
previo que mostró la copia. Un número inválido vuelve a preguntar; `0` o Enter
vacío vuelve al menú. Después introduce el ID del servidor de destino.
La opción **4** del menú principal sólo muestra la lista; no es un ID de respaldo.
Los respaldos nuevos distinguen «destino previo» y «copia del origen»; los antiguos
siguen disponibles como «respaldo». Se permite restaurar el servidor original
del respaldo. La restauración también reemplaza recursos y pide
`CLONAR`; no es un deshacer perfecto: sólo recupera lo incluido en la captura,
sus recursos disponibles y lo que Discord permita recrear. No recupera mensajes.

Si venías de una versión antigua, sus respaldos de `src/src/cloner/` no aparecen
automáticamente en el menú nuevo. Puedes conservarlos aparte y copiar sus JSON a
`backups/`; el lector valida el formato antes de usarlos.

## Desarrollo y otros sistemas

```sh
npm ci
npm run check
npm test
npm start
```

En Windows usa `start.bat`. El encabezado muestra `liam · ft8d`; `NO_COLOR=1`
desactiva el degradado. El arranque usa únicamente TypeScript y dependencias npm,
sin ejecutables adicionales del repositorio original.

Las pruebas locales simulan respuestas de Discord y cubren el orden de copia,
errores, foros, Comunidad, AutoMod, onboarding, cupos y cachés de imágenes,
reutilización, pausas, descarga con plazos, token con asteriscos, teclado sin
borrado de menús, nombres de roles, selección de respaldos y ausencia de consultas
al historial en el modo rápido. No sustituyen
una prueba de extremo a extremo con servidores reales.
