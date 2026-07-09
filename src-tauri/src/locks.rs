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
}
