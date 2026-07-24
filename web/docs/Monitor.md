# Monitor de recursos

Cada sesión SSH puede mostrar, en vivo, cómo va el servidor remoto: uso de CPU, memoria, disco, red y los procesos que más consumen. Rustty lo dibuja él mismo a partir de la información que lee por la **propia conexión SSH**, así que **no hace falta instalar nada en el servidor**: funciona contra cualquier servidor Linux al que ya te conectes.

Es opcional y se enciende por sesión. Nada sale de tu equipo ni del servidor: no hay agentes, cuentas ni telemetría.

## Encenderlo

En una sesión SSH conectada, la barra inferior (junto a la latencia) muestra dos botones:

- **Botón del monitor** (icono de gráfica): enciende o apaga el muestreo de esa sesión. Al activarlo, aparecen en la barra los indicadores compactos **CPU**, **RAM** y **Disco**, que se refrescan solos. Pasa el ratón por encima para ver el detalle (memoria usada/total, punto de montaje y espacio del disco).
- **Botón del panel** (icono de recuadro): abre el panel ampliado con gráficas.

Si prefieres que el monitor se encienda automáticamente al conectar, puedes dejarlo activado por defecto (ver «Preferencias»).

## El panel ampliado

El panel se **acopla a la sesión partiendo la pantalla**, sin taparte el terminal. Con su botón de orientación puedes ponerlo **debajo del terminal (horizontal)** o **a un lado (vertical)**, según te venga mejor.

Muestra:

- **CPU**: porcentaje de uso y su evolución reciente.
- **Memoria**: usada respecto al total.
- **Red**: velocidad de bajada y subida, con su evolución.
- **Disco**: una barra por cada sistema de ficheros montado.
- **Tiempo encendido** del servidor.
- **Procesos**: los que más CPU consumen, con su %CPU y %MEM.

## Cómo lo obtiene

Rustty abre un canal breve sobre la conexión SSH que ya tienes autenticada (sin volver a pedir contraseña ni segundo factor) y lee las interfaces estándar del sistema (`/proc`, `df`, `ps`). Con eso calcula el uso de CPU y las velocidades de red comparando dos muestras consecutivas, y pinta las gráficas.

El **intervalo de muestreo** es configurable. Un intervalo más corto actualiza más a menudo a cambio de algo más de tráfico; uno más largo es más liviano.

## Límites

- **Solo Linux** de momento. En servidores que no exponen `/proc` (algunos BSD/macOS) los indicadores pueden aparecer como «n/d»; el soporte de más sistemas llegará más adelante.
- Es una **lectura**, no un gestor de procesos: de momento el monitor observa, no actúa sobre el servidor.

## Preferencias

El monitor es **opt-in**: viene desactivado y solo se muestrea cuando lo enciendes. El estado se recuerda por sesión y sobrevive a las reconexiones automáticas.

En **Preferencias → Sistema → Monitor de recursos** puedes ajustar:

- **Activar automáticamente al conectar**: enciende el monitor en cada sesión nueva sin tener que pulsar el botón. Si lo dejas desactivado, lo enciendes a mano por sesión.
- **Tasa de refresco**: cada cuánto se toma una muestra, desde **Tiempo real (1 s)** hasta cada 10 segundos. Un intervalo más corto actualiza más a menudo a cambio de algo más de tráfico.
- **Orientación del panel por defecto**: si el panel ampliado se abre **debajo** del terminal (horizontal) o **a un lado** (vertical). Dentro del panel puedes cambiarla en cualquier momento con su botón de orientación.
