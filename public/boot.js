// Bootstrap del arranque (ejecutado en el <head>, antes del primer pintado).
//
// Vive como fichero externo servido desde el propio origen ('self') en lugar
// de un <script> inline para que la CSP de producción pueda usar
// `script-src 'self'` sin abrir `'unsafe-inline'`. Hace cuatro cosas, todas a
// partir de las preferencias guardadas en localStorage (aquí todavía no hay
// bundle, ni i18n, ni backend):
//
// 1. Anti-flash de tema: aplica la clase del tema guardado y marca el
//    documento como "booting"; el CSS oculta #app mientras esa clase esté
//    presente. init() (main.js) la retira cuando los temas bundled ya están
//    registrados y aplicados; el setTimeout es una salvaguarda por si init()
//    fallara antes de revelar la app.
// 2. Pantalla de carga (#boot-screen, en index.html): si el usuario la apagó
//    en Preferencias («Pantalla de carga al arrancar»), marca `no-boot-screen`
//    y el CSS no la pinta; la ventana entonces espera a que la interfaz esté
//    montada. Y si pidió reducir movimiento, `reduce-motion` en <html> para que
//    la barra no se anime ni un frame (main.js pone la clase en <body> después).
// 3. El texto «Iniciando…» en el idioma guardado. El <span> aún no existe (este
//    script corre en el <head>), así que se escribe al terminar el parseo
//    (readyState "interactive"), que llega antes de ejecutar el bundle. Cinco
//    cadenas duplicadas del catálogo a propósito: applyTranslations() las
//    remata con `boot.starting` en cuanto main.js arranca.
// 4. Enseñar la ventana en ese mismo momento. Nace oculta (`visible: false`)
//    y, parseado el documento con el CSS aplicado, ya hay algo que pintar: la
//    pantalla de carga. Evaluar el bundle es el tramo largo del arranque, así
//    que no se espera a él. La API de Tauri aún no está cargada: va por el
//    puente interno (`__TAURI_INTERNALS__.invoke`); si no existiera o fallara,
//    main.js lo pide desde init() y no se pierde nada. Con la pantalla de carga
//    apagada no se pide: la ventana espera a la interfaz montada. El instante
//    queda en `data-revealed-at` para que main.js cuente desde ahí el mínimo
//    de la pantalla.
(function () {
  var html = document.documentElement;
  var prefs = null;
  try {
    html.classList.add("booting");
    prefs = JSON.parse(localStorage.getItem("rustty-prefs") || "null");
    var t = prefs && prefs.theme ? prefs.theme : "system";
    if (t === "system") {
      t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    if (t && t !== "dark") html.classList.add("theme-" + t);
  } catch (e) {}
  setTimeout(function () {
    html.classList.remove("booting");
  }, 3000);

  try {
    if (prefs && prefs.bootScreen === false) html.classList.add("no-boot-screen");
    if (prefs && prefs.reduceMotion) html.classList.add("reduce-motion");
    var STARTING = {
      es: "Iniciando…",
      en: "Starting…",
      fr: "Démarrage…",
      pt: "A iniciar…",
      de: "Wird gestartet…",
    };
    var lang = prefs && prefs.lang ? prefs.lang : navigator.language || "es";
    lang = String(lang).toLowerCase().slice(0, 2);
    var text = STARTING[lang] || STARTING.es;
    var bridge = window.__TAURI_INTERNALS__;
    var revealEarly =
      !!(bridge && typeof bridge.invoke === "function") &&
      !(prefs && prefs.bootScreen === false);
    var onParsed = function () {
      var el = document.getElementById("boot-screen-text");
      if (el) el.textContent = text;
      if (!revealEarly) return;
      bridge.invoke("reveal_main_window").then(
        function (shown) {
          if (shown) html.dataset.revealedAt = String(Math.round(performance.now()));
        },
        function () {}
      );
    };
    if (document.readyState !== "loading") {
      onParsed();
    } else {
      document.addEventListener("readystatechange", function onReady() {
        if (document.readyState === "loading") return;
        document.removeEventListener("readystatechange", onReady);
        onParsed();
      });
    }
  } catch (e) {}
})();
