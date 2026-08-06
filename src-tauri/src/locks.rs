//! Bloqueo de `Mutex` tolerante a envenenamiento.
//!
//! Un `Mutex` de `std` se «envenena» si un hilo entra en pánico mientras tiene
//! el lock: a partir de ahí `lock().unwrap()` **también** entra en pánico en el
//! siguiente que lo tome. En los hilos de sesión (`ssh_manager`, `sftp_manager`,
//! `local_shell_manager`) eso mataría el hilo en silencio y dejaría la sesión
//! zombi. `lock_recover()` recupera el guard del envenenamiento en vez de
//! propagar el pánico: el dato puede quedar inconsistente, pero seguir vivo es
//! preferible a una cascada de hilos muertos.

use std::sync::{Mutex, MutexGuard};

/// Extensión de `std::sync::Mutex` para tomar el lock sin entrar en pánico ante
/// un envenenamiento (ver el módulo).
pub trait MutexExt<T: ?Sized> {
    /// Toma el lock recuperando el guard si el `Mutex` estaba envenenado.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        // `PoisonError::into_inner` devuelve el guard subyacente: el envenenamiento
        // solo marca «alguien cayó con el lock», no invalida el dato.
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::MutexExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn lock_recover_sigue_funcionando_tras_envenenar() {
        let m = Arc::new(Mutex::new(0u32));
        // Envenenamos el mutex: un hilo entra en pánico con el lock tomado.
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("envenena el mutex a propósito");
        })
        .join();

        // `lock().unwrap()` entraría en pánico aquí; `lock_recover()` no.
        assert!(m.lock().is_err(), "el mutex debería estar envenenado");
        *m.lock_recover() += 1;
        assert_eq!(*m.lock_recover(), 1);
    }

    /// Guardián del invariante de `AGENTS.md`: fuera de este módulo **no puede
    /// quedar ni un `lock().unwrap()`**. Se barrió entero en v1.54.0 y aun así
    /// volvieron a colarse dos (`external_client::disconnect_all` y
    /// `rdp_manager::disconnect_all`) porque nada lo comprobaba: una regla que
    /// solo vive en la documentación se rompe sin que nadie se entere.
    #[test]
    fn ningun_modulo_toma_el_lock_con_unwrap() {
        let mut offenders = Vec::new();
        let mut pending = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(dir) = pending.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(err) => panic!("no se puede recorrer {}: {err}", dir.display()),
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().is_none_or(|ext| ext != "rs") {
                    continue;
                }
                // Este fichero es la única excepción: aquí vive la conversión.
                if path.file_name().is_some_and(|name| name == "locks.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                // Solo se mira el código de producción: dentro de un test, un
                // `lock().unwrap()` que entra en pánico ES el fallo del test.
                // El corte en el primer `#[cfg(test)]` es conservador a
                // propósito (podría dejar fuera código real escrito debajo),
                // pero nunca da un falso positivo.
                let code = match text.find("#[cfg(test)]") {
                    Some(idx) => &text[..idx],
                    None => &text[..],
                };
                let lines: Vec<&str> = code.lines().collect();
                for (n, line) in lines.iter().enumerate() {
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    // rustfmt parte la cadena, así que se busca en una línea y
                    // en el par `.lock()` + `.unwrap()` consecutivos.
                    let split = line.trim_end().ends_with(".lock()")
                        && lines.get(n + 1).is_some_and(|next| next.trim() == ".unwrap()");
                    if line.contains(".lock().unwrap()") || split {
                        offenders.push(format!("{}:{}", path.display(), n + 1));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "usa `lock_recover()` (locks.rs) en lugar de `lock().unwrap()`: {offenders:?}"
        );
    }
}
