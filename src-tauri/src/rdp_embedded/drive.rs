//! Carpeta compartida de la sesión integrada (canal `RDPDR`, redirección de
//! unidades): una carpeta local aparece en el remoto como unidad
//! («<nombre> en rustty» en el Explorador), en lectura y escritura.
//!
//! La carpeta la elige el usuario con el diálogo nativo que abre **el backend**
//! y se guarda aquí, en el directorio de datos: el frontend solo la enseña o la
//! quita. Así el código de la página nunca puede decidir qué parte del disco se
//! expone a un servidor remoto (mismo criterio que [`crate::file_grants`]).
//! Y no vale cualquiera: ni la carpeta de datos ni `~/.ssh`, ni nada que las
//! contenga o esté dentro (`LocalFsGuard::check_share`), al elegirla y otra vez
//! al conectar.
//!
//! El acceso al disco lo hace `ironrdp-rdpdr-native`, que resuelve cada ruta
//! del servidor componente a componente bajo la carpeta abierta, sin seguir
//! enlaces ni puntos de reanálisis.

use std::path::{Path, PathBuf};

use ironrdp_rdpdr::Rdpdr;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::local_fs_guard::LocalFsGuard;
use crate::DataDir;

const CONFIG_FILE: &str = "rdp_shared_folder.json";
/// Id de dispositivo de la unidad (0 está reservado a la tarjeta inteligente).
const DRIVE_DEVICE_ID: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Config {
    path: Option<PathBuf>,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

/// La carpeta compartida guardada, si sigue existiendo.
#[must_use]
pub fn configured(data_dir: &Path) -> Option<PathBuf> {
    let raw = std::fs::read(config_path(data_dir)).ok()?;
    let cfg: Config = serde_json::from_slice(&raw).ok()?;
    cfg.path.filter(|p| p.is_dir())
}

fn save(data_dir: &Path, path: Option<PathBuf>) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(&Config { path }).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&config_path(data_dir), &data, true).map_err(|e| e.to_string())
}

/// Nombre con el que se anuncia la unidad: el de la carpeta.
fn drive_name(path: &Path) -> String {
    let name: String = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect();
    let name = name.trim();
    if name.is_empty() || name.ends_with(':') {
        "Rustty".to_string()
    } else {
        name.to_string()
    }
}

/// Backend nativo y unidades `(id, nombre)` que anuncia.
type NativeBackend = (
    Box<dyn ironrdp_rdpdr::backend::RdpdrBackend>,
    Vec<(u32, String)>,
);

/// Monta el canal `RDPDR` con la carpeta como unidad.
pub fn build(path: &Path, computer_name: &str) -> Result<Rdpdr, String> {
    let name = drive_name(path);
    let (backend, drives) = native_backend(path, name)?;
    Ok(Rdpdr::new(backend, computer_name.to_string()).with_drives(Some(drives)))
}

#[cfg(windows)]
fn native_backend(path: &Path, name: String) -> Result<NativeBackend, String> {
    use ironrdp_rdpdr::backend::RdpdrBackendFactory as _;
    use ironrdp_rdpdr_native::{RedirectedDrive, WindowsRdpdrBackendFactory};

    let drive = RedirectedDrive::new(DRIVE_DEVICE_ID, name, path, false)
        .map_err(|e| format!("carpeta compartida no válida ({}): {e}", path.display()))?;
    let product = WindowsRdpdrBackendFactory::new(drive)
        .build_rdpdr_backend()
        .map_err(|e| e.to_string())?;
    let (backend, drives) = product.into_parts();
    Ok((
        backend,
        drives.into_iter().map(|d| d.into_parts()).collect(),
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_backend(path: &Path, name: String) -> Result<NativeBackend, String> {
    use ironrdp_rdpdr::backend::RdpdrBackendFactory as _;
    use ironrdp_rdpdr_native::backend::NixRdpdrBackendFactory;

    let product = NixRdpdrBackendFactory::new(path.to_string_lossy().into_owned())
        .with_drive(DRIVE_DEVICE_ID, name)
        .build_rdpdr_backend()
        .map_err(|e| e.to_string())?;
    let (backend, drives) = product.into_parts();
    Ok((
        backend,
        drives.into_iter().map(|d| d.into_parts()).collect(),
    ))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn native_backend(_path: &Path, _name: String) -> Result<NativeBackend, String> {
    Err("carpeta compartida no disponible en esta plataforma".into())
}

/// Lo que ve el frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFolder {
    path: Option<String>,
}

fn view(path: Option<PathBuf>) -> SharedFolder {
    SharedFolder {
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn rdp_shared_folder_get(data_dir: State<'_, DataDir>) -> SharedFolder {
    view(configured(&data_dir.0))
}

/// Abre el diálogo de carpeta y guarda la elegida. `None` = cancelado.
/// Una carpeta que no se puede compartir falla con `local-fs:protected|…`.
#[tauri::command]
pub async fn rdp_shared_folder_pick(
    window: tauri::Window,
    data_dir: State<'_, DataDir>,
    guard: State<'_, LocalFsGuard>,
    title: Option<String>,
) -> Result<Option<SharedFolder>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    {
        builder = builder.set_parent(&window);
    }
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        builder = builder.set_title(title);
    }
    if let Some(current) = configured(&data_dir.0) {
        builder = builder.set_directory(current);
    }
    let Some(picked) = builder
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .filter(|p| p.is_dir())
    else {
        return Ok(None);
    };
    guard.check_share(&picked)?;
    save(&data_dir.0, Some(picked.clone()))?;
    Ok(Some(view(Some(picked))))
}

#[tauri::command]
pub fn rdp_shared_folder_clear(data_dir: State<'_, DataDir>) -> Result<(), String> {
    save(&data_dir.0, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nombre_de_la_unidad() {
        assert_eq!(drive_name(Path::new("/home/ana/Compartida")), "Compartida");
        assert_eq!(drive_name(Path::new("/")), "Rustty");
    }

    #[test]
    fn guarda_y_quita_la_carpeta() {
        let dir = std::env::temp_dir().join(format!("rustty-drive-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(configured(&dir).is_none());
        save(&dir, Some(dir.clone())).unwrap();
        assert_eq!(configured(&dir), Some(dir.clone()));
        save(&dir, None).unwrap();
        assert!(configured(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn monta_el_canal_con_la_carpeta() {
        let dir = std::env::temp_dir();
        assert!(build(&dir, "rustty").is_ok());
    }
}
