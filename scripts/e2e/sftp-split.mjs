// Divisor central del panel SFTP (`modules/sftp/split.js`) en el WebView real,
// con el panel abierto contra el `sshd` del smoke: arrastrar reparte el ancho
// entre los dos lados, el teclado del `role="separator"` lo mueve a pasos, el
// doble clic vuelve a la mitad y el reparto se guarda en las preferencias.
import { sleep } from "./webdriver.mjs";

const settle = () => sleep(200);

export async function checkSftpSplit(app, check) {
  const measure = () => app.exec(`
    const panel = document.querySelector(".sftp-panel-split");
    const grip = panel?.querySelector(".sftp-split-grip");
    if (!panel || !grip) return null;
    const [left, right] = panel.classList.contains("sftp-remote-right")
      ? [panel.querySelector(".sftp-side-local"), panel.querySelector(".sftp-side-remote")]
      : [panel.querySelector(".sftp-side-remote"), panel.querySelector(".sftp-side-local")];
    const box = grip.getBoundingClientRect();
    return {
      left: left.getBoundingClientRect().width,
      right: right.getBoundingClientRect().width,
      now: grip.getAttribute("aria-valuenow"),
      stored: JSON.parse(localStorage.getItem("rustty-prefs")).sftpSplitRatio,
      gripX: Math.round(box.left + box.width / 2),
      gripY: Math.round(box.top + 6),
    };
  `);
  const start = await measure();
  check("el panel SFTP tiene divisor central arrastrable", !!start, String(start));
  if (!start) return;
  check("de serie los dos lados miden lo mismo", Math.abs(start.left - start.right) < 2 && start.now === "50",
    JSON.stringify(start));

  // Arrastre de verdad: puntero en coordenadas de viewport.
  await app.actions({
    actions: [{
      type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", origin: "viewport", x: start.gripX, y: start.gripY },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", origin: "viewport", x: start.gripX + 120, y: start.gripY, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    }],
  });
  await settle();
  const dragged = await measure();
  check("arrastrar el divisor reparte el ancho y lo guarda",
    !!dragged && dragged.left > dragged.right + 100 && dragged.stored > 0.55 && Number(dragged.now) > 55,
    JSON.stringify(dragged));

  const key = async (k) => {
    await app.exec(`
      const grip = document.querySelector(".sftp-split-grip");
      grip.focus();
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: arguments[0], bubbles: true, cancelable: true }));
      return true;
    `, [k]);
    await settle();
    return measure();
  };
  const home = await key("Home");
  check("Inicio lleva el divisor al tope izquierdo", home?.now === "20" && home.left < home.right, JSON.stringify(home));
  const step = await key("ArrowRight");
  check("las flechas lo mueven a pasos", step?.now === "25", JSON.stringify(step));

  await app.exec(`
    document.querySelector(".sftp-split-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  `);
  await settle();
  const reset = await measure();
  check("doble clic vuelve a la mitad", reset?.now === "50" && reset.stored === 0.5 && Math.abs(reset.left - reset.right) < 2,
    JSON.stringify(reset));
}
