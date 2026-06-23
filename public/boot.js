// Anti-flash de tema (ejecutado antes del primer pintado).
//
// Vive como fichero externo servido desde el propio origen ('self') en lugar
// de un <script> inline para que la CSP de producción pueda usar
// `script-src 'self'` sin abrir `'unsafe-inline'`. Aplica la clase del tema
// guardado y marca el documento como "booting"; el CSS oculta #app mientras
// esa clase esté presente. init() (main.js) la retira cuando los temas bundled
// ya están registrados y aplicados; el setTimeout es una salvaguarda por si
// init() fallara antes de revelar la app.
(function () {
  try {
    document.documentElement.classList.add("booting");
    var p = JSON.parse(localStorage.getItem("rustty-prefs") || "null");
    var t = p && p.theme ? p.theme : "system";
    if (t === "system") {
      t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    if (t && t !== "dark") document.documentElement.classList.add("theme-" + t);
  } catch (e) {}
  setTimeout(function () {
    document.documentElement.classList.remove("booting");
  }, 3000);
})();
