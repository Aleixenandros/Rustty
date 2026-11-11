// Notas de conexión, menú de texto y «Duplicar» como borrador, por la interfaz.
//
// Crea una conexión con nota y comprueba: el menú contextual ofrece el
// submenú «Nota ▸» (ver, editar, eliminar) en vez de «Añadir nota»; la fila
// trae los botones «Conectar» y «Ver nota» entre sus acciones; «Ver nota» abre
// el modal en lectura (sin editor, con título y etiquetas) y «Editar» pasa a
// edición; el clic derecho en el cuerpo de la nota abre el menú de texto por
// encima del diálogo, con «Formato ▸», y sus acciones (negrita, eliminar,
// deshacer, seleccionar todo) actúan sobre el campo; Escape cierra el menú sin
// cerrar la nota. Copiar y pegar no se prueban: tocarían el portapapeles real
// del escritorio. Por último, «Duplicar» abre el formulario relleno sin crear
// nada; cancelar no deja copia y guardar crea una sola.
import { sleep } from "./webdriver.mjs";

const ID = "e2e-note-a";

export async function checkNotesAndText(app, check) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const all = await invoke("get_profiles");
  const base = all.find((p) => p.id === "e2e-sync") || all[0];
  if (!base) throw new Error("falta un perfil de partida para probar las notas");
  await invoke("save_profiles", {
    profiles: [{
      ...base,
      id: ID,
      name: "e2e-nota",
      host: "nota.corp",
      group: null,
      connection_type: "ssh",
      auth_type: "password",
      password_source: "own",
      keepass_entry_uuid: null,
      master_credential_id: null,
      extra_credentials: [],
      ssh_tunnels: [],
      proxy_jump: null,
      proxy_jump_profile_id: null,
    }],
  });
  await invoke("note_set", {
    profileId: ID,
    body: "# Runbook\n\n- [ ] paso uno\n",
    title: "Guía de guardia",
    connection: "e2e-nota",
    tags: ["prod", "db"],
  });
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);

  const settle = () => sleep(250);
  const visible = (css) => app.exec(`
    const el = document.querySelector(arguments[0]);
    return !!el && !el.classList.contains("hidden") && el.offsetParent !== null;
  `, [css]);
  const openCtx = async () => {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      const item = document.querySelector('#connection-list .conn-item[data-id="${ID}"]');
      if (!item) return false;
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5,
      }));
      return true;
    `);
    await app.waitFor("#context-menu:not(.hidden)");
  };
  const textMenuOn = (css) => app.exec(`
    const el = document.querySelector(arguments[0]);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 20,
    }));
    return !document.getElementById("text-context-menu").classList.contains("hidden");
  `, [css]);
  const clickText = (action, format = "") => app.exec(`
    const sel = arguments[1]
      ? '#text-context-menu [data-text-menu="format"][data-format="' + arguments[1] + '"]'
      : '#text-context-menu [data-text-menu="' + arguments[0] + '"]';
    const btn = document.querySelector(sel);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  `, [action, format]);
  const textarea = (start, end, value = null) => app.exec(`
    const ta = document.getElementById("note-editor-textarea");
    if (arguments[2] !== null) ta.value = arguments[2];
    ta.focus();
    ta.setSelectionRange(arguments[0], arguments[1]);
    return true;
  `, [start, end, value]);
  const taValue = () => app.exec('return document.getElementById("note-editor-textarea").value;');

  try {
    await app.exec(`
      const input = document.getElementById("sidebar-search");
      input.value = "e2e-nota";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await app.waitFor(`#connection-list .conn-item[data-id="${ID}"]`);

    // ── Botones de la fila ───────────────────────────────────────
    const rowActions = await app.exec(`
      const row = document.querySelector('#connection-list .conn-item[data-id="${ID}"]');
      return [...row.querySelectorAll(".conn-item-actions [data-action]")].map((b) => b.dataset.action);
    `);
    check("la fila trae «Conectar» y «Ver nota» junto a favorito, editar y eliminar",
      ["connect", "view-note", "toggle-favorite", "edit", "delete"].every((a) => rowActions.includes(a)),
      rowActions.join(","));

    // ── Submenú «Nota ▸» ─────────────────────────────────────────
    await openCtx();
    const ctx = await app.exec(`
      const menu = document.getElementById("context-menu");
      const add = menu.querySelector('.ctx-note-missing[data-ctx="edit-note"]');
      const parent = document.getElementById("ctx-note");
      const items = [...document.querySelectorAll("#ctx-note-submenu [data-ctx]")].map((b) => b.dataset.ctx);
      return { addHidden: add.classList.contains("hidden"), parentShown: !parent.classList.contains("hidden"), items };
    `);
    check("con nota, el menú ofrece «Nota ▸» (ver, editar, eliminar) y no «Añadir nota»",
      ctx.addHidden && ctx.parentShown && ctx.items.join(",") === "view-note,edit-note,delete-note",
      JSON.stringify(ctx));

    // Menú con scroll interno (ventana baja): el `overflow` del menú recortaba
    // el submenú al pintarlo aunque `elementFromPoint` lo diera por visible,
    // así que se mira lo que lo saca de verdad de la caja: la capa superior.
    // Con el puntero real (acciones WebDriver), no con eventos sintéticos, y
    // moviéndolo PASO A PASO: de un salto no se pisa la franja que separa el
    // ítem de su submenú (borde, barra de desplazamiento, hueco), que es donde
    // el submenú se perdía.
    const move = (x, y) => app.actions({ actions: [{
      type: "pointer", id: "raton", parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y), origin: "viewport" }],
    }] });
    const glide = async (from, to, { stepPx = 3, pauseMs = 15 } = {}) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / stepPx));
      for (let i = 0; i <= steps; i++) {
        await move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        await sleep(pauseMs);
      }
    };
    const rect = (js) => app.exec(`const r = (${js}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height];`);
    const subState = () => app.exec(`
      const menu = document.getElementById("context-menu");
      const parent = document.getElementById("ctx-note");
      const sub = document.getElementById("ctx-note-submenu");
      const r = sub.getBoundingClientRect();
      const iconColor = (el) => el ? getComputedStyle(el).color : null;
      return {
        topLayer: sub.matches(":popover-open"),
        position: getComputedStyle(sub).position,
        shown: getComputedStyle(sub).display !== "none",
        expanded: parent.getAttribute("aria-expanded"),
        overflow: menu.classList.contains("menu-overflow"),
        right: r.left > menu.getBoundingClientRect().right - 1,
        parentBg: getComputedStyle(parent).backgroundColor,
        plainBg: getComputedStyle(menu.querySelector('[data-ctx="copy-host"]')).backgroundColor,
        subIcon: iconColor(sub.querySelector('[data-ctx="edit-note"] > .ctx-icon')),
        plainIcon: iconColor(menu.querySelector('[data-ctx="copy-host"] > .ctx-icon')),
      };
    `);
    /** Del ítem «Nota ▸» a su submenú, despacio y parándose en la franja intermedia. */
    const crossIntoNoteSubmenu = async () => {
      await app.exec('document.getElementById("ctx-note").scrollIntoView({ block: "nearest" }); return true;');
      const item = await rect('document.getElementById("ctx-note")');
      const start = [item[0] + 40, item[1] + item[3] / 2];
      await move(start[0], start[1]);
      await sleep(400);
      const onParent = await subState();
      const sub = await rect('document.getElementById("ctx-note-submenu")');
      const box = await rect('document.getElementById("context-menu")');
      const y = Math.min(Math.max(start[1], sub[1] + 10), sub[1] + sub[3] - 10);
      // Hasta el borde derecho de la caja del menú (relleno o barra de
      // desplazamiento, ya fuera del ítem) y ahí se queda más que el margen.
      const edge = [box[0] + box[2] - 3, y];
      await glide(start, edge);
      await sleep(700);
      const onEdge = await subState();
      await glide(edge, [sub[0] + 30, y]);
      await sleep(500);
      return { onParent, onEdge, inSub: await subState(), item, sub };
    };

    await app.resize(1000, 460);
    await sleep(800);
    await openCtx();
    await sleep(300);
    const low = await crossIntoNoteSubmenu();
    check("con el menú acotado con scroll, el submenú «Nota ▸» sale de la caja hacia la derecha (capa superior)",
      low.onParent.overflow && low.onParent.topLayer && low.onParent.shown && low.onParent.right, JSON.stringify(low.onParent));
    check("los iconos del submenú no toman el color del padre resaltado (no se pierden contra el fondo)",
      !!low.onParent.subIcon && low.onParent.subIcon === low.onParent.plainIcon,
      `${low.onParent.subIcon} / ${low.onParent.plainIcon}`);
    check("parado en el borde del menú, camino del submenú, este sigue abierto",
      low.onEdge.shown, JSON.stringify(low.onEdge));
    check("al llegar con el puntero al submenú, sigue abierto y su padre resaltado",
      low.inSub.shown && low.inSub.expanded === "true" && low.inSub.parentBg !== low.inSub.plainBg,
      JSON.stringify(low.inSub));
    const hostRect = await rect('document.querySelector(\'#context-menu [data-ctx="copy-host"]\')');
    await glide([low.sub[0] + 30, low.sub[1] + 15], [hostRect[0] + 40, hostRect[1] + hostRect[3] / 2], { stepPx: 12 });
    await sleep(200);
    const onOther = await subState();
    check("al pasar a otra opción del menú, el submenú se pliega enseguida", !onOther.shown, JSON.stringify(onOther));
    await move(low.item[0] + 40, low.item[1] + low.item[3] / 2);
    await sleep(300);
    await glide([low.item[0] + 40, low.item[1] + low.item[3] / 2], [low.item[0] + 420, low.item[1] - 120], { stepPx: 20 });
    await sleep(700);
    const away = await subState();
    check("al sacar el puntero del menú sin entrar en el submenú, este se pliega tras el margen", !away.shown, JSON.stringify(away));
    await app.exec(`
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return true;
    `);
    await sleep(200);
    const released = await app.exec(`
      return document.getElementById("context-menu").classList.contains("hidden")
        && !document.getElementById("ctx-note-submenu").matches(":popover-open");
    `);
    check("al cerrar el menú, el submenú deja la capa superior", released, String(released));
    await move(5, 5);
    await app.resize(1500, 900);
    await sleep(800);

    // Lo mismo con el menú entero (sin scroll): submenú absoluto de siempre.
    await openCtx();
    await sleep(300);
    const tall = await crossIntoNoteSubmenu();
    check("con el menú entero, el submenú «Nota ▸» también aguanta el cruce del puntero",
      !tall.onParent.overflow && !tall.onParent.topLayer && tall.onParent.shown && tall.onEdge.shown && tall.inSub.shown,
      JSON.stringify({ onParent: tall.onParent.shown, onEdge: tall.onEdge.shown, inSub: tall.inSub.shown, position: tall.inSub.position }));
    await move(5, 5);
    await sleep(500);
    await openCtx();

    // ── Ver nota: lectura ────────────────────────────────────────
    await app.jsClick('#ctx-note-submenu [data-ctx="view-note"]');
    await app.waitFor("#note-editor-overlay:not(.hidden)");
    await settle();
    const view = await app.exec(`
      const modal = document.getElementById("note-editor-modal");
      const shown = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
      return {
        isView: modal.classList.contains("is-view"),
        textarea: shown("note-editor-textarea"),
        toolbar: shown("note-editor-toolbar"),
        edit: shown("note-view-edit"),
        save: shown("note-editor-save"),
        meta: document.getElementById("note-view-meta").textContent,
        preview: document.getElementById("note-editor-preview").textContent,
        task: !!document.querySelector('#note-editor-preview input[type="checkbox"][data-task-index]'),
      };
    `);
    check("«Ver nota» abre en lectura: sin editor ni barra, con título, etiquetas y «Editar»",
      view.isView && !view.textarea && !view.toolbar && view.edit && !view.save
        && /Guía de guardia/.test(view.meta) && /prod/.test(view.meta) && /Runbook/.test(view.preview) && view.task,
      JSON.stringify(view));

    // Marcar la casilla en lectura la guarda en el .md.
    await app.jsClick('#note-editor-preview input[type="checkbox"][data-task-index]');
    await sleep(600);
    const saved = await invoke("note_get", { profileId: ID });
    check("marcar una casilla en lectura la guarda en la nota", /- \[x\] paso uno/.test(saved?.body || ""),
      JSON.stringify(saved?.body));

    // ── Copiar desde la lectura ──────────────────────────────────
    // El texto pintado se puede seleccionar (pese al `user-select: none` del
    // body) y el clic derecho ofrece Copiar, Seleccionar todo y «Copiar como
    // Markdown» aunque no haya selección.
    const selectable = await app.exec(`
      const p = document.querySelector("#note-editor-preview p, #note-editor-preview li, #note-editor-preview h1, #note-editor-preview h2");
      const cs = getComputedStyle(p || document.getElementById("note-editor-preview"));
      return cs.userSelect || cs.webkitUserSelect;
    `);
    check("el texto de la nota en lectura se puede seleccionar", selectable === "text", selectable);
    await app.exec("window.getSelection().removeAllRanges(); return true;");
    const viewMenu = await textMenuOn("#note-editor-preview");
    const viewItems = await app.exec(`
      return [...document.querySelectorAll("#text-context-menu > [data-text-menu]")]
        .map((b) => b.dataset.textMenu + (b.disabled ? ":off" : ""));
    `);
    check("el clic derecho en la nota en lectura ofrece Copiar, Seleccionar todo y Copiar como Markdown",
      viewMenu && viewItems.join(",") === "copy:off,select-all,copy-source", JSON.stringify(viewItems));
    await clickText("select-all");
    await settle();
    const selAll = await app.exec(`
      const sel = window.getSelection();
      const preview = document.getElementById("note-editor-preview");
      return { text: sel.toString(), inside: sel.rangeCount > 0 && preview.contains(sel.getRangeAt(0).commonAncestorContainer) };
    `);
    check("«Seleccionar todo» selecciona solo la nota", selAll.inside && /Runbook/.test(selAll.text), JSON.stringify(selAll));
    await textMenuOn("#note-editor-preview");
    const copyOn = await app.exec(`return !document.querySelector('#text-context-menu [data-text-menu="copy"]').disabled;`);
    check("con la nota seleccionada, «Copiar» está activo", copyOn, String(copyOn));
    await app.exec(`document.getElementById("text-context-menu").classList.add("hidden"); window.getSelection().removeAllRanges(); return true;`);
    const ctrlA = await app.exec(`
      const preview = document.getElementById("note-editor-preview");
      preview.focus();
      preview.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
      return window.getSelection().toString();
    `);
    check("Ctrl+A en la nota en lectura selecciona la nota", /Runbook/.test(ctrlA), JSON.stringify(ctrlA));
    await app.exec("window.getSelection().removeAllRanges(); return true;");

    // ── Editar ───────────────────────────────────────────────────
    await app.jsClick("#note-view-edit");
    await settle();
    const edit = await app.exec(`
      const modal = document.getElementById("note-editor-modal");
      return {
        isView: modal.classList.contains("is-view"),
        textarea: document.getElementById("note-editor-textarea").offsetParent !== null,
        value: document.getElementById("note-editor-textarea").value,
      };
    `);
    check("«Editar» pasa a edición con el texto ya marcado",
      !edit.isView && edit.textarea && /- \[x\] paso uno/.test(edit.value), JSON.stringify(edit));

    // ── Menú de texto dentro de la nota ──────────────────────────
    await textarea(5, 10, "hola mundo");
    const opened = await textMenuOn("#note-editor-textarea");
    const layer = await app.exec(`
      const z = (id) => Number(getComputedStyle(document.getElementById(id)).zIndex) || 0;
      const items = [...document.querySelectorAll("#text-context-menu > [data-text-menu]")].map((b) => b.dataset.textMenu);
      return {
        above: z("text-context-menu") > z("note-editor-overlay"),
        items,
        format: !!document.getElementById("text-menu-format"),
        cutEnabled: !document.querySelector('#text-context-menu [data-text-menu="cut"]').disabled,
      };
    `);
    check("el clic derecho en la nota abre el menú de texto encima del diálogo, con «Formato ▸»",
      opened && layer.above && layer.format && layer.cutEnabled
        && ["undo", "redo", "cut", "copy", "paste", "delete", "select-all"].every((a) => layer.items.includes(a)),
      JSON.stringify(layer));

    await clickText("format", "bold");
    await settle();
    check("«Formato ▸ Negrita» envuelve la selección", (await taValue()) === "hola **mundo**", await taValue());

    await textarea(0, 5);
    await textMenuOn("#note-editor-textarea");
    await clickText("delete");
    await settle();
    check("«Eliminar» borra la selección", (await taValue()) === "**mundo**", await taValue());

    await textMenuOn("#note-editor-textarea");
    const undoOk = await clickText("undo");
    await settle();
    check("«Deshacer» recupera lo borrado", undoOk && (await taValue()) === "hola **mundo**", await taValue());

    await textarea(0, 0);
    await textMenuOn("#note-editor-textarea");
    const noSel = await app.exec(`
      const d = (a) => document.querySelector('#text-context-menu [data-text-menu="' + a + '"]').disabled;
      return { cut: d("cut"), copy: d("copy"), paste: d("paste") };
    `);
    check("sin selección, «Cortar» y «Copiar» salen apagados y «Pegar» no",
      noSel.cut && noSel.copy && !noSel.paste, JSON.stringify(noSel));
    await clickText("select-all");
    await settle();
    const all = await app.exec(`
      const ta = document.getElementById("note-editor-textarea");
      return ta.selectionStart === 0 && ta.selectionEnd === ta.value.length;
    `);
    check("«Seleccionar todo» selecciona el campo entero", all);

    await textMenuOn("#note-editor-textarea");
    await app.exec(`
      document.querySelector("#text-context-menu [data-text-menu]").focus();
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return true;
    `);
    await settle();
    check("Escape cierra el menú de texto sin cerrar la nota",
      !(await visible("#text-context-menu")) && (await visible("#note-editor-modal")));

    // Un campo corriente (el buscador de la barra lateral) también tiene menú,
    // sin «Formato».
    await app.exec('document.getElementById("note-editor-cancel").click(); return true;');
    await app.waitFor("#note-editor-overlay.hidden");
    await settle();
    const plain = await textMenuOn("#sidebar-search");
    const plainFormat = await app.exec('return !!document.getElementById("text-menu-format");');
    check("un campo normal también abre el menú de texto, sin «Formato»", plain && !plainFormat);
    await app.exec('document.getElementById("text-context-menu").classList.add("hidden"); return true;');

    // ── «Duplicar» es un borrador ────────────────────────────────
    const count = async () => (await invoke("get_profiles")).filter((p) => p.host === "nota.corp").length;
    const before = await count();
    await openCtx();
    await app.jsClick('#context-menu [data-ctx="duplicate-conn"]');
    await app.waitFor("#modal-overlay:not(.hidden)");
    await sleep(600);
    const draft = await app.exec(`return {
      name: document.getElementById("f-name").value,
      host: document.getElementById("f-host").value,
      title: document.getElementById("modal-title").textContent,
    };`);
    const afterOpen = await count();
    check("«Duplicar» abre el formulario relleno sin crear la copia",
      afterOpen === before && draft.host === "nota.corp" && /e2e-nota/.test(draft.name) && draft.name !== "e2e-nota",
      JSON.stringify({ before, afterOpen, ...draft }));
    await app.jsClick("#btn-modal-cancel");
    await app.waitFor("#modal-overlay.hidden");
    await sleep(400);
    check("cancelar el duplicado no deja ninguna copia", (await count()) === before);

    await openCtx();
    await app.jsClick('#context-menu [data-ctx="duplicate-conn"]');
    await app.waitFor("#modal-overlay:not(.hidden)");
    await sleep(600);
    await app.jsClick("#btn-modal-save-only");
    await app.waitFor("#modal-overlay.hidden");
    await sleep(800);
    const copies = (await invoke("get_profiles")).filter((p) => p.host === "nota.corp" && p.id !== ID);
    check("guardar el duplicado crea una sola copia con id propio",
      copies.length === 1 && (await count()) === before + 1, JSON.stringify(copies.map((p) => [p.id, p.name])));
  } finally {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      document.getElementById("text-context-menu").classList.add("hidden");
      document.getElementById("note-editor-overlay").classList.add("hidden");
      const input = document.getElementById("sidebar-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `).catch(() => {});
    const left = (await invoke("get_profiles").catch(() => [])).filter((p) => p.host === "nota.corp").map((p) => p.id);
    await app.invoke("note_delete", { profileId: ID });
    if (left.length) await app.invoke("delete_profiles", { ids: left });
  }
}
