use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Wry};

use crate::local_shell_manager::LocalShellManager;
use crate::locks::MutexExt;
use crate::rdp_manager::RdpManager;
use crate::sftp_manager::SftpManager;
use crate::ssh_manager::SshManager;

const ID_SHOW: &str = "tray:show";
const ID_HIDE: &str = "tray:hide";
const ID_LOCAL_SHELL: &str = "tray:local-shell";
const ID_NEW_CONNECTION: &str = "tray:new-connection";
const ID_QUIT: &str = "tray:quit";
const PREFIX_CONNECT: &str = "tray:connect:";
const PREFIX_WORKSPACE: &str = "tray:workspace:";
const PREFIX_WAKE: &str = "tray:wake:";

#[derive(Default)]
pub struct TrayState {
    inner: Mutex<Option<TrayParts>>,
}

struct TrayParts {
    _tray: TrayIcon<Wry>,
    favorites: Submenu<Wry>,
    recent: Submenu<Wry>,
    workspaces: Submenu<Wry>,
    wake: Submenu<Wry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayQuickLauncherPayload {
    #[serde(default)]
    favorites: Vec<TrayProfileItem>,
    #[serde(default)]
    recent: Vec<TrayProfileItem>,
    #[serde(default)]
    workspaces: Vec<TrayWorkspaceItem>,
    #[serde(default)]
    wake: Vec<TrayProfileItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayProfileItem {
    id: String,
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayWorkspaceItem {
    id: String,
    label: String,
}

pub fn setup(app: &mut App) {
    app.manage(TrayState::default());
    if let Err(err) = build_tray(app) {
        eprintln!("No se pudo crear la bandeja del sistema: {err}");
    }
}

fn build_tray(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ID_SHOW, "Mostrar Rustty", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, ID_HIDE, "Ocultar ventana", true, None::<&str>)?;
    let local_shell = MenuItem::with_id(
        app,
        ID_LOCAL_SHELL,
        "Nueva consola local",
        true,
        None::<&str>,
    )?;
    let new_connection = MenuItem::with_id(
        app,
        ID_NEW_CONNECTION,
        "Nueva conexión…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Salir de Rustty", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let favorites = Submenu::with_id_and_items(app, "tray:favorites", "Favoritos", true, &[])?;
    let recent = Submenu::with_id_and_items(app, "tray:recent", "Recientes", true, &[])?;
    let workspaces = Submenu::with_id_and_items(app, "tray:workspaces", "Perfiles", true, &[])?;
    let wake = Submenu::with_id_and_items(app, "tray:wake", "Wake On LAN", true, &[])?;

    add_placeholder(app, &favorites, "Sin favoritos")?;
    add_placeholder(app, &recent, "Sin recientes")?;
    add_placeholder(app, &workspaces, "Default")?;
    add_placeholder(app, &wake, "Sin equipos")?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &sep1,
            &local_shell,
            &new_connection,
            &sep2,
            &favorites,
            &recent,
            &workspaces,
            &wake,
            &sep3,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("rustty-tray")
        .menu(&menu)
        .tooltip("Rustty")
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    app.state::<TrayState>().replace(TrayParts {
        _tray: tray,
        favorites,
        recent,
        workspaces,
        wake,
    });
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    match id {
        ID_SHOW => show_main_window(app),
        ID_HIDE => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        ID_LOCAL_SHELL => {
            show_main_window(app);
            emit_action(app, serde_json::json!({ "action": "local-shell" }));
        }
        ID_NEW_CONNECTION => {
            show_main_window(app);
            emit_action(app, serde_json::json!({ "action": "new-connection" }));
        }
        ID_QUIT => {
            shutdown_sessions(app);
            app.exit(0);
        }
        _ if id.starts_with(PREFIX_CONNECT) => {
            show_main_window(app);
            emit_action(
                app,
                serde_json::json!({
                    "action": "connect-profile",
                    "profileId": id.trim_start_matches(PREFIX_CONNECT),
                }),
            );
        }
        _ if id.starts_with(PREFIX_WAKE) => {
            show_main_window(app);
            emit_action(
                app,
                serde_json::json!({
                    "action": "wake-profile",
                    "profileId": id.trim_start_matches(PREFIX_WAKE),
                }),
            );
        }
        _ if id.starts_with(PREFIX_WORKSPACE) => {
            show_main_window(app);
            emit_action(
                app,
                serde_json::json!({
                    "action": "switch-workspace",
                    "workspaceId": id.trim_start_matches(PREFIX_WORKSPACE),
                }),
            );
        }
        _ => {}
    }
}

fn emit_action(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit(crate::ipc::TRAY_ACTION, payload);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn shutdown_sessions(app: &AppHandle) {
    app.state::<SshManager>().disconnect_all();
    app.state::<SftpManager>().disconnect_all();
    app.state::<LocalShellManager>().close_all();
    app.state::<RdpManager>().disconnect_all();
    // VNC/Telnet también: salir por la bandeja no debe dejar visores/clientes
    // externos huérfanos (coherente con `close_app` y `CloseRequested`).
    app.state::<crate::external_client::VncManager>()
        .disconnect_all();
    app.state::<crate::external_client::TelnetManager>()
        .disconnect_all();
}

impl TrayState {
    fn replace(&self, parts: TrayParts) {
        *self.inner.lock_recover() = Some(parts);
    }

    fn update(&self, app: &AppHandle, payload: TrayQuickLauncherPayload) -> tauri::Result<()> {
        let guard = self.inner.lock_recover();
        let Some(parts) = guard.as_ref() else {
            return Ok(());
        };

        replace_profile_submenu(
            app,
            &parts.favorites,
            &payload.favorites,
            PREFIX_CONNECT,
            "Sin favoritos",
        )?;
        replace_profile_submenu(
            app,
            &parts.recent,
            &payload.recent,
            PREFIX_CONNECT,
            "Sin recientes",
        )?;
        replace_workspace_submenu(app, &parts.workspaces, &payload.workspaces)?;
        replace_profile_submenu(app, &parts.wake, &payload.wake, PREFIX_WAKE, "Sin equipos")?;

        parts
            .favorites
            .set_text(format!("Favoritos ({})", payload.favorites.len()))?;
        parts
            .recent
            .set_text(format!("Recientes ({})", payload.recent.len()))?;
        parts
            .workspaces
            .set_text(format!("Perfiles ({})", payload.workspaces.len()))?;
        parts
            .wake
            .set_text(format!("Wake On LAN ({})", payload.wake.len()))?;
        Ok(())
    }
}

fn replace_profile_submenu(
    app: &AppHandle,
    submenu: &Submenu<Wry>,
    items: &[TrayProfileItem],
    id_prefix: &str,
    empty_label: &str,
) -> tauri::Result<()> {
    clear_submenu(submenu)?;
    if items.is_empty() {
        return add_placeholder(app, submenu, empty_label);
    }
    for item in items.iter().take(8) {
        let menu_item = MenuItem::with_id(
            app,
            format!("{id_prefix}{}", item.id),
            clamp_label(&item.label),
            true,
            None::<&str>,
        )?;
        submenu.append(&menu_item)?;
    }
    Ok(())
}

fn replace_workspace_submenu(
    app: &AppHandle,
    submenu: &Submenu<Wry>,
    items: &[TrayWorkspaceItem],
) -> tauri::Result<()> {
    clear_submenu(submenu)?;
    if items.is_empty() {
        return add_placeholder(app, submenu, "Default");
    }
    for item in items.iter().take(12) {
        let menu_item = MenuItem::with_id(
            app,
            format!("{PREFIX_WORKSPACE}{}", item.id),
            clamp_label(&item.label),
            true,
            None::<&str>,
        )?;
        submenu.append(&menu_item)?;
    }
    Ok(())
}

fn clear_submenu(submenu: &Submenu<Wry>) -> tauri::Result<()> {
    while !submenu.items()?.is_empty() {
        let _ = submenu.remove_at(0)?;
    }
    Ok(())
}

fn add_placeholder<M: Manager<Wry>>(
    manager: &M,
    submenu: &Submenu<Wry>,
    label: &str,
) -> tauri::Result<()> {
    let item = MenuItem::new(manager, label, false, None::<&str>)?;
    submenu.append(&item)
}

fn clamp_label(label: &str) -> String {
    let clean = label.replace('\n', " ");
    let mut out = String::new();
    for ch in clean.chars().take(64) {
        out.push(ch);
    }
    if clean.chars().count() > 64 {
        out.push('…');
    }
    out
}

#[tauri::command]
pub fn tray_update_quick_launcher(
    app: AppHandle,
    state: tauri::State<'_, TrayState>,
    payload: TrayQuickLauncherPayload,
) -> Result<(), String> {
    state.update(&app, payload).map_err(|e| e.to_string())
}
