// Configuración ESLint (flat config) del frontend de Rustty.
//
// Alcance actual: los módulos ya extraídos en `src/modules/` y `src/sync.js`,
// más los ficheros de tooling (config + scripts). Los god-files heredados
// (`src/main.js`, `src/i18n.js`) quedan IGNORADOS hasta que el refactor por
// dominios (ver `memoria/tareas.md` § «Refactor arquitectónico») los trocee en módulos;
// el alcance del lint crecerá con cada extracción.
//
// Reglas mínimas (error): no-unused-vars, no-implicit-globals, prefer-const.
// `eslint-plugin-jsdoc` se aplica como aviso (warn) en los módulos anotados.

import globals from "globals";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "web/**",
      "packaging/**",
      "public/**",
      "src-tauri/**",
    ],
  },

  // Frontend (navegador): módulos extraídos + sync.js + i18n.js (ya troceado).
  {
    files: ["src/**/*.js"],
    ignores: ["src/main.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-implicit-globals": "error",
      "prefer-const": "error",
    },
  },

  // Tests (Vitest): añaden los globals de Node al entorno de navegador.
  {
    files: ["src/**/*.test.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // JSDoc: aviso (no bloqueante) sobre los módulos ya anotados con `// @ts-check`.
  {
    files: ["src/modules/**/*.js"],
    ...jsdoc.configs["flat/recommended-typescript-flavor"],
  },
  {
    // Mantenemos las comprobaciones de corrección de JSDoc (nombres de @param,
    // tipos válidos, etiquetas conocidas) pero no exigimos descripción de prosa
    // en cada etiqueta ni penalizamos `*` cuando es un cast defensivo.
    files: ["src/modules/**/*.js"],
    rules: {
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-property-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/reject-any-type": "off",
      "jsdoc/tag-lines": "off",
    },
  },

  // Tooling Node (config de build/lint y scripts).
  {
    files: ["*.config.js", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": "error",
      "prefer-const": "error",
    },
  },

  // El god-file no entra al lint completo hasta su troceo por dominios, pero
  // SÍ a `no-undef`: un identificador que no existe es un ReferenceError en
  // runtime — así se rompió «Comprobar actualizaciones» en v1.67.0
  // (`normalizeVersion` extraída a modules/version.js sin su import) y nada
  // lo avisó, porque el fallo solo saltaba cuando HABÍA una versión nueva.
  {
    files: ["src/main.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    // Las directivas eslint-disable del fichero apuntan a reglas del lint
    // completo que aún no le aplica: no avisar de que «sobran».
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      "no-undef": "error",
    },
  },
];
