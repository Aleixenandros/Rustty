// Edición en lote de conexiones por la interfaz (`modules/profiles/bulk-edit.js`
// + la sección «EDICIÓN EN LOTE» de main.js), sin servidores reales.
//
// Crea tres conexiones SSH, las selecciona en la barra lateral (clic y
// Ctrl+clic), abre «Editar 3 conexiones…» desde el menú contextual, comprueba
// que el modal nace con los controles desactivados y el foco dentro, marca
// «Usuario», lo cambia, mira el resumen, aplica y comprueba en lo que devuelve
// `get_profiles` que solo cambió el usuario (y la fecha). Después pulsa
// «Deshacer» en el aviso y comprueba que los tres vuelven a estar como antes.
import { sleep } from "./webdriver.mjs";

const IDS = ["e2e-bulk-a", "e2e-bulk-b", "e2e-bulk-c"];

export async function checkBulkEdit(app, check) {
  const invoke = async (command, args) => {
    const result = await app.invoke(command, args);
    if (!result.ok) throw new Error(`${command}: ${result.reason}`);
    return result.value;
  };
  const all = await invoke("get_profiles");
  const base = all.find((p) => p.id === "e2e-sync") || all[0];
  if (!base) throw new Error("falta un perfil de partida para probar la edición en lote");
  const make = (id, n) => ({
    ...base,
    id,
    name: `e2e-lote-${n}`,
    host: `lote-${n}.old.corp`,
    group: null,
    port: 22,
    username: "ana",
    connection_type: "ssh",
    auth_type: "password",
    password_source: "own",
    keepass_entry_uuid: null,
    master_credential_id: null,
    extra_credentials: [],
    ssh_tunnels: [],
    proxy_jump: null,
    proxy_jump_profile_id: null,
    environment: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  await invoke("save_profiles", { profiles: IDS.map((id, i) => make(id, i + 1)) });
  await app.exec("setTimeout(() => location.reload(), 50); return true;");
  await sleep(2000);
  await app.waitForApp();
  await sleep(800);

  const settle = () => sleep(250);
  const showOnly = (query) => app.exec(`
    const input = document.getElementById("sidebar-search");
    input.value = arguments[0];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `, [query]);
  const clickItem = (id, ctrl) => app.exec(`
    const item = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
    if (!item) return false;
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: arguments[1] }));
    return true;
  `, [id, ctrl]);
  const openCtx = async (id) => {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      const item = document.querySelector('#connection-list .conn-item[data-id="' + arguments[0] + '"]');
      if (!item) return false;
      const r = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5,
      }));
      return true;
    `, [id]);
    await app.waitFor("#context-menu:not(.hidden)");
  };
  const setValue = (id, value) => app.exec(`
    const el = document.getElementById(arguments[0]);
    el.value = arguments[1];
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `, [id, value]);
  const byId = async () => {
    const list = await invoke("get_profiles");
    return Object.fromEntries(IDS.map((id) => [id, list.find((p) => p.id === id)]));
  };
  const clearToasts = () => app.exec(
    'document.querySelectorAll("#toast-container .toast").forEach((el) => el.remove()); return true;',
  );

  try {
    await showOnly("e2e-lote");
    await app.waitFor(`#connection-list .conn-item[data-id="${IDS[2]}"]`);

    // ── Selección múltiple y entrada del menú ────────────────────
    await clickItem(IDS[0], false);
    await clickItem(IDS[1], true);
    await clickItem(IDS[2], true);
    const selected = await app.exec('return document.querySelectorAll("#connection-list .conn-item.selected").length;');
    check("clic y Ctrl+clic dejan tres conexiones seleccionadas", selected === 3, String(selected));
    await openCtx(IDS[1]);
    const entry = await app.exec(`
      const el = document.getElementById("ctx-bulk-edit-selection");
      return { visible: !!el && !el.classList.contains("hidden"), label: el ? el.textContent.trim() : "" };
    `);
    check("el menú contextual ofrece «Editar 3 conexiones…»", entry.visible && /3/.test(entry.label), JSON.stringify(entry));

    // ── El modal nace con todo desactivado y el foco dentro ──────
    await clearToasts();
    await app.jsClick('#context-menu [data-ctx="bulk-edit-selection"]');
    await app.waitFor("#bulk-edit-overlay:not(.hidden)");
    await settle();
    const fresh = await app.exec(`
      const box = document.getElementById("bulk-edit-modal");
      const controls = [...box.querySelectorAll(".bulk-control input, .bulk-control select")];
      return {
        focusInside: box.contains(document.activeElement),
        allDisabled: controls.length > 0 && controls.every((el) => el.disabled),
        applyDisabled: document.getElementById("bulk-edit-apply").disabled,
        scope: document.getElementById("bulk-edit-scope").textContent,
        labelled: box.getAttribute("aria-labelledby") === "bulk-edit-title",
      };
    `);
    check("el modal abre con el foco dentro, los campos desactivados y «Aplicar» apagado",
      fresh.focusInside && fresh.allDisabled && fresh.applyDisabled && fresh.labelled && /3/.test(fresh.scope),
      JSON.stringify(fresh));

    // ── Marcar «Usuario», escribir y mirar el resumen ────────────
    await app.jsClick("#bulk-on-username");
    await settle();
    check("marcar «Cambiar» en Usuario activa su campo",
      await app.exec('return !document.getElementById("bulk-username").disabled && document.getElementById("bulk-on-username").checked;'));
    await setValue("bulk-username", "lote");
    await settle();
    const summary = await app.exec(`return {
      text: document.getElementById("bulk-edit-summary").textContent,
      applyDisabled: document.getElementById("bulk-edit-apply").disabled,
    };`);
    check("el resumen anuncia 1 campo en 3 conexiones y «Aplicar» se enciende",
      /1/.test(summary.text) && /3/.test(summary.text) && !summary.applyDisabled, JSON.stringify(summary));

    // ── Aplicar: solo cambia el usuario, en una sola escritura ───
    const before = await byId();
    await app.jsClick("#bulk-edit-apply");
    await app.waitFor("#bulk-edit-overlay.hidden");
    await sleep(800);
    const after = await byId();
    const onlyUser = IDS.every((id) => after[id]
      && after[id].username === "lote"
      && after[id].host === before[id].host
      && after[id].port === before[id].port
      && after[id].updated_at !== before[id].updated_at);
    check("aplicar cambia el usuario de las tres, conserva el resto y las fecha",
      onlyUser, JSON.stringify(IDS.map((id) => [after[id]?.username, after[id]?.host, after[id]?.updated_at])));
    const sidebar = await app.exec(`return [...document.querySelectorAll('#connection-list .conn-item')]
      .filter((el) => el.dataset.id.startsWith("e2e-bulk-")).map((el) => el.getAttribute("aria-label") || "").join("|");`);
    check("la barra lateral refleja el usuario nuevo", /lote@/.test(sidebar) && !/ana@/.test(sidebar), sidebar.slice(0, 160));

    // ── Deshacer desde el aviso ──────────────────────────────────
    const undone = await app.exec(`
      const toasts = [...document.querySelectorAll("#toast-container .toast")].filter((el) => el.querySelector(".toast-action"));
      const toast = toasts[toasts.length - 1];
      if (!toast) return false;
      toast.querySelector(".toast-action").click();
      return true;
    `);
    await sleep(1000);
    const restored = await byId();
    const back = IDS.every((id) => restored[id]
      && restored[id].username === "ana"
      && restored[id].host === before[id].host
      && restored[id].updated_at !== before[id].updated_at);
    check("«Deshacer» devuelve el usuario anterior a las tres con fecha nueva",
      undone && back, JSON.stringify(IDS.map((id) => [restored[id]?.username, restored[id]?.updated_at])));
  } finally {
    await app.exec(`
      document.getElementById("context-menu").classList.add("hidden");
      document.getElementById("bulk-edit-overlay").classList.add("hidden");
      const input = document.getElementById("sidebar-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `).catch(() => {});
    await app.invoke("delete_profiles", { ids: IDS });
  }
}
