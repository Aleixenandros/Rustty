// Selección rápida en una consola local real: etiquetas sobre lo impreso,
// copia al portapapeles, copia y pegado en el prompt, y que mientras está
// abierta ninguna tecla llega al shell. Usa el portapapeles del sistema (es lo
// que se prueba): lo que hubiera antes se restaura al terminar.
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./webdriver.mjs";

export async function checkQuickSelect(app, check, workDir) {
  const press = (code, key, modifiers = {}) => app.exec(`
    const event = new KeyboardEvent("keydown", { code: arguments[0], key: arguments[1],
      bubbles: true, cancelable: true, ...arguments[2] });
    (document.activeElement || document.body).dispatchEvent(event);
    return event.defaultPrevented;
  `, [code, key, modifiers]);
  const pane = (sid) => `.terminal-pane[data-session="${sid}"]`;
  const isOpen = (sid) => app.exec("return !!document.querySelector(arguments[0]);", [`${pane(sid)} .quick-select-layer`]);
  const labels = (sid) => app.exec(`
    return [...document.querySelectorAll(arguments[0])].map((el) => ({ label: el.dataset.label, text: el.dataset.text }));
  `, [`${pane(sid)} .quick-select-label`]);
  const openSelect = () => press("Space", " ", { ctrlKey: true, shiftKey: true });
  /** Teclea una etiqueta; con `paste`, la última letra va con Mayúsculas. */
  const typeLabel = async (label, paste = false) => {
    const letters = [...label];
    for (const [i, letter] of letters.entries()) {
      const shifted = paste && i === letters.length - 1;
      await press(`Key${letter.toUpperCase()}`, shifted ? letter.toUpperCase() : letter, { shiftKey: shifted });
    }
  };
  const readClipboard = async () => {
    const result = await app.invoke("plugin:clipboard-manager|read_text");
    return result.ok ? result.value : null;
  };

  const before = await readClipboard();
  const ip = "192.168.77.21";
  const hash = "3f9a2c1d7b";
  const pasted = path.join(workDir, "quick-select.txt");

  await app.jsClick("#btn-welcome-local");
  await app.waitFor(".xterm-helper-textarea");
  await sleep(2500);
  const sid = await app.lastSessionId();
  try {
    await app.typeIntoLocalShell(sid, `clear; printf 'ip ${ip} hash ${hash}\\n'\n`);
    await sleep(1500);
    await app.exec("document.querySelector(arguments[0])?.focus(); return true;", [`${pane(sid)} .xterm-helper-textarea`]);

    const consumed = await openSelect();
    check("Ctrl+Shift+Espacio abre la selección rápida en la consola", consumed && await isOpen(sid));
    const found = await labels(sid);
    const ipLabel = found.find((l) => l.text === ip)?.label;
    const hashLabel = found.find((l) => l.text === hash)?.label;
    check("marca la IP y el hash impresos, cada uno con su etiqueta",
      Boolean(ipLabel && hashLabel && ipLabel !== hashLabel), JSON.stringify(found));
    const unique = [...new Set(found.map((l) => l.label))];
    check("ninguna etiqueta es prefijo de otra",
      unique.every((a) => unique.every((b) => a === b || !b.startsWith(a))), unique.join(" "));

    // Una tecla que no es etiqueta se queda en la selección: si llegara al
    // shell, la orden del pegado de más abajo empezaría por «7» y fallaría.
    const swallowed = await press("Digit7", "7");
    check("con la selección abierta una tecla ajena no llega al terminal", swallowed && await isOpen(sid));

    if (ipLabel) await typeLabel(ipLabel);
    await sleep(500);
    check("la letra copia lo marcado y cierra la selección",
      !await isOpen(sid) && await readClipboard() === ip, String(await readClipboard()));

    await openSelect();
    await press("Escape", "Escape");
    check("Escape cancela sin copiar", !await isOpen(sid) && await readClipboard() === ip);
    await openSelect();
    await openSelect();
    check("el mismo atajo la vuelve a cerrar", !await isOpen(sid));

    // Mayúscula: copia y además pega en el prompt, donde ya espera la orden.
    await app.typeIntoLocalShell(sid, "printf '%s\\n' ");
    await sleep(800);
    await openSelect();
    const again = (await labels(sid)).find((l) => l.text === hash)?.label;
    if (again) await typeLabel(again, true);
    await sleep(500);
    await app.typeIntoLocalShell(sid, ` > '${pasted}'\n`);
    await sleep(1500);
    const written = fs.existsSync(pasted) ? fs.readFileSync(pasted, "utf8") : "";
    check("la mayúscula copia y pega en el prompt", written === `${hash}\n` && await readClipboard() === hash,
      JSON.stringify(written));
  } finally {
    await app.typeIntoLocalShell(sid, "exit\n").catch(() => {});
    if (typeof before === "string") {
      await app.invoke("plugin:clipboard-manager|write_text", { text: before }).catch(() => {});
    }
  }
}
