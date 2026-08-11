// @ts-check
/**
 * Búsqueda de conexiones: normalización, puntuación, agrupación y resaltado.
 *
 * Núcleo puro de los buscadores de la sidebar y del dashboard. Sustituye al
 * antiguo «haystack» plano (todos los campos concatenados + `includes`) por:
 *
 *  - Normalización sin diacríticos («produccion» encuentra «producción»).
 *  - Consulta multi-palabra con semántica AND: cada token debe coincidir en
 *    algún campo del perfil, no hace falta que sean contiguos.
 *  - Puntuación por relevancia: nombre > host > usuario > protocolo >
 *    carpeta > nota, con exacto > prefijo > subcadena. El texto manda, como
 *    en la paleta de comandos.
 *  - Agrupación: las coincidencias directas (atributos propios del perfil) se
 *    separan de las carpetas cuyo nombre coincide (una entrada por carpeta,
 *    con recuento, en lugar de volcar todas sus conexiones) y de los perfiles
 *    que solo coinciden por su nota.
 *  - Segmentación de coincidencias para resaltarlas en el render.
 *
 * Sin DOM ni estado global: perfiles, carpetas y notas llegan por parámetro.
 */

/** @typedef {{ text: string, hit: boolean }} MatchSegment */
/**
 * @typedef {object} ProfileScore
 * @property {number} score Relevancia acumulada (mayor = mejor).
 * @property {Set<string>} fields Campos donde hubo coincidencia:
 *   "name" | "host" | "username" | "protocol" | "group" | "note".
 */
/**
 * @typedef {object} ConnectionMatch
 * @property {any} profile
 * @property {number} score
 * @property {Set<string>} fields
 */
/**
 * @typedef {object} FolderMatch
 * @property {string} path Ruta completa de la carpeta ("a/b/c").
 * @property {string} name Último segmento de la ruta.
 * @property {string} workspaceId
 * @property {number} count Conexiones bajo la carpeta (recursivo).
 * @property {number} score
 */
/**
 * @typedef {object} GroupedSearch
 * @property {string[]} tokens Tokens normalizados de la consulta.
 * @property {ConnectionMatch[]} connections Coincidencias directas, por relevancia.
 * @property {FolderMatch[]} folders Carpetas cuyo nombre coincide, por relevancia.
 * @property {ConnectionMatch[]} notes Perfiles que solo coinciden por su nota.
 * @property {ConnectionMatch[]} folderOnly Perfiles que solo coinciden por su
 *   carpeta (representados por `folders`; útiles para la lista plana clásica).
 */

const COMBINING_RE = /[\u0300-\u036f]/g;

/**
 * Minúsculas y sin diacríticos, para comparar texto de búsqueda. NFKD y no
 * NFD: las formas de compatibilidad (ligaduras «ﬁ», anchos completos) también
 * se pliegan, así «file» encuentra «ﬁle-server» pegado desde un PDF.
 * @param {unknown} value
 * @returns {string}
 */
export function foldSearchText(value) {
  return String(value ?? "").normalize("NFKD").replace(COMBINING_RE, "").toLowerCase();
}

/**
 * Trocea la consulta en tokens normalizados (semántica AND). La «/» separa
 * como el espacio: «rancher/prod» busca igual que «rancher prod», con lo que
 * pegar una ruta de carpeta encuentra la carpeta y sus conexiones.
 * @param {unknown} query
 * @returns {string[]}
 */
export function searchTokens(query) {
  return foldSearchText(query).split(/[\s/]+/).filter(Boolean);
}

/**
 * Nivel de coincidencia de un token contra un valor ya normalizado:
 * 3 exacto, 2 prefijo, 1 subcadena, 0 nada.
 * @param {string} folded
 * @param {string} token
 */
function matchLevel(folded, token) {
  if (!folded || !token) return 0;
  if (folded === token) return 3;
  if (folded.startsWith(token)) return 2;
  if (folded.includes(token)) return 1;
  return 0;
}

/**
 * Peso de cada campo según el nivel de coincidencia (índice = nivel 1..3).
 * El nombre domina; carpeta y nota puntúan bajo para que el contexto no
 * desplace a las coincidencias directas.
 */
const FIELD_WEIGHTS = {
  name:     [0, 70, 85, 100],
  host:     [0, 45, 52, 60],
  username: [0, 32, 36, 40],
  protocol: [0, 0, 24, 30], // solo exacto o prefijo: "ssh" no debe matchear por subcadena
  group:    [0, 12, 16, 20],
  note:     [0, 6, 8, 10],
};

/**
 * Puntúa un perfil contra los tokens. Todos los tokens deben coincidir en
 * algún campo (AND); si alguno no coincide, devuelve `null`.
 *
 * @param {any} profile
 * @param {string[]} tokens Tokens ya normalizados (de `searchTokens`).
 * @param {{ title?: string, tags?: string[], excerpt?: string } | undefined} [note]
 * @returns {ProfileScore | null}
 */
export function scoreProfile(profile, tokens, note) {
  if (!tokens.length) return { score: 0, fields: new Set() };
  const noteText = note
    ? [note.title, ...(note.tags || []), note.excerpt].filter(Boolean).join(" ")
    : "";
  /** @type {Array<[keyof typeof FIELD_WEIGHTS, string]>} */
  const candidates = [
    ["name", foldSearchText(profile?.name)],
    ["host", foldSearchText(profile?.host)],
    ["username", foldSearchText(profile?.username)],
    ["protocol", foldSearchText(profile?.connection_type || "ssh")],
    ["group", foldSearchText(profile?.group)],
    ["note", foldSearchText(noteText)],
  ];
  let score = 0;
  const fields = new Set();
  for (const token of tokens) {
    let best = 0;
    const tokenFields = [];
    for (const [field, folded] of candidates) {
      const weight = FIELD_WEIGHTS[field][matchLevel(folded, token)];
      if (weight > 0) tokenFields.push(field);
      if (weight > best) best = weight;
    }
    if (best === 0) return null;
    score += best;
    for (const field of tokenFields) fields.add(field);
  }
  return { score, fields };
}

/** Campos que convierten una coincidencia en «directa» (atributos propios). */
const DIRECT_FIELDS = ["name", "host", "username", "protocol"];

/** @param {ProfileScore} result */
function isDirectMatch(result) {
  return DIRECT_FIELDS.some((field) => result.fields.has(field));
}

/**
 * Orden estable: relevancia descendente y nombre alfabético de desempate.
 * @param {ConnectionMatch} a
 * @param {ConnectionMatch} b
 */
function byRelevance(a, b) {
  return b.score - a.score
    || String(a.profile?.name || "").localeCompare(String(b.profile?.name || ""));
}

/**
 * Agrupa los resultados de búsqueda.
 *
 * Una carpeta coincide cuando su **nombre propio** (último segmento) matchea
 * algún token y la ruta completa satisface todos los tokens; así «rancher»
 * lista la carpeta `rancher` pero no cada subcarpeta suya, y «rancher prod»
 * encuentra `rancher/prod`.
 *
 * @param {object} input
 * @param {any[]} input.profiles Perfiles ya filtrados por el scope de workspaces.
 * @param {{ path: string, workspaceId: string }[]} [input.folders] Carpetas
 *   conocidas (manuales, pueden estar vacías); las derivadas de `profile.group`
 *   se añaden solas.
 * @param {Map<string, any>} [input.notes] profileId → resumen de nota.
 * @param {string} input.query
 * @returns {GroupedSearch}
 */
export function groupConnectionSearch({ profiles, folders = [], notes, query }) {
  const tokens = searchTokens(query);
  /** @type {ConnectionMatch[]} */ const connections = [];
  /** @type {ConnectionMatch[]} */ const noteMatches = [];
  /** @type {ConnectionMatch[]} */ const folderOnly = [];

  if (!tokens.length) {
    for (const profile of profiles) connections.push({ profile, score: 0, fields: new Set() });
    connections.sort(byRelevance);
    return { tokens, connections, folders: [], notes: [], folderOnly: [] };
  }

  for (const profile of profiles) {
    const result = scoreProfile(profile, tokens, notes?.get(profile?.id));
    if (!result) continue;
    const match = { profile, score: result.score, fields: result.fields };
    if (isDirectMatch(result)) connections.push(match);
    else if (result.fields.has("note")) noteMatches.push(match);
    else folderOnly.push(match);
  }
  connections.sort(byRelevance);
  noteMatches.sort(byRelevance);
  folderOnly.sort(byRelevance);

  // Universo de carpetas: las manuales recibidas + todos los prefijos de los
  // `group` de los perfiles, por workspace.
  /** @type {Map<string, { path: string, workspaceId: string }>} */
  const known = new Map();
  const addFolder = (/** @type {string} */ path, /** @type {string} */ workspaceId) => {
    const parts = String(path || "").split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      const partial = parts.slice(0, i).join("/");
      known.set(`${workspaceId}|${partial}`, { path: partial, workspaceId });
    }
  };
  for (const folder of folders) addFolder(folder?.path, folder?.workspaceId || "default");
  for (const profile of profiles) {
    if (profile?.group) addFolder(profile.group, profile?.workspace_id || "default");
  }

  /** @type {FolderMatch[]} */ const folderMatches = [];
  for (const { path, workspaceId } of known.values()) {
    const name = path.split("/").filter(Boolean).pop() || path;
    const foldedPath = foldSearchText(path);
    if (!tokens.every((token) => foldedPath.includes(token))) continue;
    const foldedName = foldSearchText(name);
    let bestName = 0;
    for (const token of tokens) {
      const level = matchLevel(foldedName, token);
      if (level > bestName) bestName = level;
    }
    if (bestName === 0) continue;
    const count = profiles.filter((p) => {
      if ((p?.workspace_id || "default") !== workspaceId || !p?.group) return false;
      // Mismo saneo que addFolder: un group sucio ("a//b", "/a") cuenta bajo
      // su ruta normalizada en vez de dejar la carpeta anunciando 0.
      const group = String(p.group).split("/").filter(Boolean).join("/");
      return group === path || group.startsWith(`${path}/`);
    }).length;
    folderMatches.push({ path, name, workspaceId, count, score: FIELD_WEIGHTS.name[bestName] });
  }
  folderMatches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return { tokens, connections, folders: folderMatches, notes: noteMatches, folderOnly };
}

/**
 * Segmenta `text` marcando las coincidencias de los tokens, con índices sobre
 * el texto ORIGINAL (mayúsculas y acentos intactos) aunque la comparación sea
 * normalizada: resaltar «Producción» al buscar «produccion» funciona.
 *
 * @param {string} text
 * @param {string[]} tokens Tokens ya normalizados.
 * @returns {MatchSegment[]}
 */
export function matchSegments(text, tokens) {
  const raw = String(text ?? "");
  if (!raw) return [];
  const clean = tokens.filter(Boolean);
  if (!clean.length) return [{ text: raw, hit: false }];

  // Pliega carácter a carácter guardando de qué carácter original sale cada
  // carácter plegado; así una coincidencia en el texto plegado se traduce a
  // rangos del original sin desincronizarse con los diacríticos.
  const chars = [...raw];
  let folded = "";
  /** @type {number[]} */ const origin = [];
  /** @type {boolean[]} */ const foldedEmpty = [];
  chars.forEach((ch, index) => {
    const piece = foldSearchText(ch);
    foldedEmpty.push(piece === "");
    // Una entrada de `origin` por UNIDAD UTF-16, no por punto de código:
    // indexOf y token.length miden en unidades, y un emoji ocupa dos.
    folded += piece;
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index);
  });

  const hits = new Array(chars.length).fill(false);
  for (const token of clean) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at === -1) break;
      for (let k = at; k < at + token.length; k += 1) hits[origin[k]] = true;
      from = at + 1;
    }
  }
  // Una marca combinante suelta (texto descompuesto) hereda el estado del
  // carácter anterior para no partir un resaltado por la mitad.
  for (let i = 1; i < chars.length; i += 1) {
    if (foldedEmpty[i]) hits[i] = hits[i - 1];
  }

  /** @type {MatchSegment[]} */ const segments = [];
  let buffer = "";
  let current = hits[0];
  chars.forEach((ch, index) => {
    if (hits[index] === current) {
      buffer += ch;
      return;
    }
    segments.push({ text: buffer, hit: current });
    buffer = ch;
    current = hits[index];
  });
  if (buffer) segments.push({ text: buffer, hit: current });
  return segments;
}
