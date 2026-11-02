//! Build sin la feature `embedded-rdp`: los mismos comandos, que responden que
//! el cliente integrado no está disponible, para que el frontend use el
//! cliente externo sin tener que conocer cómo se compiló el backend.

use tauri::ipc::{Channel, Request, Response};

const UNAVAILABLE: &str = "Esta versión de Rustty no incluye el cliente RDP integrado";

#[derive(Default)]
pub struct EmbeddedRdpManager;

impl EmbeddedRdpManager {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub fn disconnect_all(&self) {}
}

#[derive(serde::Serialize)]
pub struct KnownCert;

#[allow(clippy::too_many_arguments, clippy::unused_async, unused_variables)]
#[tauri::command]
pub async fn rdp_embed_connect(
    session_id: String,
    profile_id: String,
    width: u32,
    height: u32,
    on_frame: Channel<Response>,
) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_input(request: Request<'_>) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_resize(session_id: String, width: u32, height: u32) {}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_ack(session_id: String, seq: u32) {}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_disconnect(session_id: String) {}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_cert_response(prompt_id: String, accept: bool) -> bool {
    false
}

#[tauri::command]
pub fn rdp_known_certs_list() -> Vec<KnownCert> {
    Vec::new()
}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_known_cert_remove(host_port: String) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn rdp_embed_available() -> bool {
    false
}

pub mod certs {
    pub fn register_app(_app: tauri::AppHandle) {}
}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_clipboard_sync(session_id: String) {}

#[allow(clippy::unused_async, unused_variables)]
#[tauri::command]
pub async fn rdp_embed_clipboard_save(
    session_id: String,
    offer: u32,
    title: Option<String>,
) -> Result<bool, String> {
    Err(UNAVAILABLE.into())
}

#[allow(unused_variables)]
#[tauri::command]
pub fn rdp_embed_clipboard_cancel(session_id: String) {}

pub mod drive {
    use super::UNAVAILABLE;

    #[derive(serde::Serialize)]
    pub struct SharedFolder {
        path: Option<String>,
    }

    #[tauri::command]
    pub fn rdp_shared_folder_get() -> SharedFolder {
        SharedFolder { path: None }
    }

    #[allow(clippy::unused_async, unused_variables)]
    #[tauri::command]
    pub async fn rdp_shared_folder_pick(
        title: Option<String>,
    ) -> Result<Option<SharedFolder>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub fn rdp_shared_folder_clear() -> Result<(), String> {
        Ok(())
    }
}
