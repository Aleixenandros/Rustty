//! Cambio de tamaño del escritorio por Display Control (MS-RDPEDISP).
//!
//! El canal dinámico se abre después de la activación y no sirve hasta que el
//! servidor manda sus capacidades; hay servidores que no lo ofrecen nunca
//! (Windows antiguos, algunos xrdp). Aquí vive la lógica pura de ese estado:
//! qué petición mandar ya, cuál guardar para cuando el canal esté listo y
//! cuándo avisar al frontend de si el servidor admite el cambio de tamaño (si
//! no, el canvas escala y elegir una resolución fija reconecta la sesión).

use std::time::Duration;

use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;

/// Margen tras conectar para que llegue el canal: pasado sin capacidades, se
/// da por hecho que el servidor no lo ofrece (si llega después, se avisa).
pub const GRACE: Duration = Duration::from_secs(5);

/// Petición de tamaño ya ajustada a lo que admite el protocolo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResizeRequest {
    pub width: u32,
    pub height: u32,
    /// Escala del escritorio en % (100..=500); fuera de rango no se manda.
    pub scale: Option<u32>,
}

impl ResizeRequest {
    /// Ancho par y ambos lados en 200..=8192 (MS-RDPEDISP 2.2.2.2.1).
    #[must_use]
    pub fn normalized(width: u32, height: u32, scale: Option<u32>) -> Self {
        let (width, height) = MonitorLayoutEntry::adjust_display_size(width, height);
        Self {
            width,
            height,
            scale: scale.filter(|s| (100..=500).contains(s)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Support {
    /// Aún no se sabe (canal abriéndose o sin capacidades).
    Unknown,
    Ready,
    /// Pasó el margen sin canal.
    Unsupported,
}

/// Lo que toca hacer tras mirar el canal.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Observed {
    /// Avisar al frontend: `true` admite el cambio de tamaño, `false` no.
    pub report: Option<bool>,
    /// Petición guardada que ya se puede mandar.
    pub send: Option<ResizeRequest>,
}

/// Estado del cambio de tamaño de una sesión.
#[derive(Debug)]
pub struct Resizer {
    support: Support,
    /// Última petición sin mandar (solo cuenta la última).
    pending: Option<ResizeRequest>,
    /// Lo último avisado al frontend, para no repetirlo.
    reported: Option<bool>,
}

impl Default for Resizer {
    fn default() -> Self {
        Self {
            support: Support::Unknown,
            pending: None,
            reported: None,
        }
    }
}

impl Resizer {
    /// ¿Hay que seguir mirando si el canal está listo?
    #[must_use]
    pub fn needs_poll(&self) -> bool {
        self.support != Support::Ready
    }

    /// ¿Sigue corriendo el margen inicial?
    #[must_use]
    pub fn awaiting(&self) -> bool {
        self.support == Support::Unknown && self.reported.is_none()
    }

    /// Petición del frontend: `Some` = mandarla ya; si no, queda guardada
    /// (sustituye a la anterior) hasta que el canal esté listo.
    pub fn request(&mut self, req: ResizeRequest) -> Option<ResizeRequest> {
        if self.support == Support::Ready {
            self.pending = None;
            Some(req)
        } else {
            self.pending = Some(req);
            None
        }
    }

    /// Estado del canal tras procesar una PDU.
    pub fn observe(&mut self, ready: bool) -> Observed {
        if !ready || self.support == Support::Ready {
            return Observed::default();
        }
        self.support = Support::Ready;
        Observed {
            report: self.report(true),
            send: self.pending.take(),
        }
    }

    /// Venció el margen inicial sin canal. Lo guardado se descarta: el
    /// frontend, al saberlo, decide (escalar o reconectar).
    pub fn give_up(&mut self) -> Option<bool> {
        if !self.awaiting() {
            return None;
        }
        self.support = Support::Unsupported;
        self.pending = None;
        self.report(false)
    }

    /// El canal dejó de aceptar la petición (se cerró, p. ej. en una
    /// reactivación): se guarda y se manda cuando vuelva.
    pub fn requeue(&mut self, req: ResizeRequest) {
        self.support = Support::Unknown;
        self.pending = Some(req);
    }

    fn report(&mut self, value: bool) -> Option<bool> {
        if self.reported == Some(value) {
            return None;
        }
        self.reported = Some(value);
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(w: u32, h: u32) -> ResizeRequest {
        ResizeRequest::normalized(w, h, None)
    }

    #[test]
    fn normaliza_tamano_y_escala() {
        assert_eq!(
            ResizeRequest::normalized(1921, 100, Some(150)),
            ResizeRequest {
                width: 1920,
                height: 200,
                scale: Some(150)
            }
        );
        assert_eq!(ResizeRequest::normalized(9000, 9000, Some(99)).scale, None);
        assert_eq!(ResizeRequest::normalized(9000, 9000, Some(501)).width, 8192);
        assert_eq!(
            ResizeRequest::normalized(800, 600, Some(500)).scale,
            Some(500)
        );
    }

    #[test]
    fn antes_del_canal_guarda_la_ultima_peticion() {
        let mut r = Resizer::default();
        assert!(r.needs_poll());
        assert!(r.awaiting());
        assert_eq!(r.request(req(1024, 768)), None);
        assert_eq!(r.request(req(1280, 720)), None);
        assert_eq!(r.observe(false), Observed::default());
        assert_eq!(
            r.observe(true),
            Observed {
                report: Some(true),
                send: Some(req(1280, 720)),
            }
        );
        assert!(!r.needs_poll());
        // Ya listo: se manda en el acto y no se repite el aviso.
        assert_eq!(r.request(req(800, 600)), Some(req(800, 600)));
        assert_eq!(r.observe(true), Observed::default());
        // El margen ya no aplica.
        assert_eq!(r.give_up(), None);
    }

    #[test]
    fn sin_canal_avisa_una_vez_y_descarta() {
        let mut r = Resizer::default();
        assert_eq!(r.request(req(1024, 768)), None);
        assert_eq!(r.give_up(), Some(false));
        assert!(!r.awaiting());
        assert_eq!(r.give_up(), None);
        // Si el canal llega tarde, se avisa y no se manda lo descartado.
        assert_eq!(
            r.observe(true),
            Observed {
                report: Some(true),
                send: None,
            }
        );
    }

    #[test]
    fn canal_cerrado_reencola_sin_repetir_aviso() {
        let mut r = Resizer::default();
        assert_eq!(r.observe(true).report, Some(true));
        r.requeue(req(1600, 900));
        assert!(r.needs_poll());
        // No vuelve a correr el margen inicial.
        assert!(!r.awaiting());
        assert_eq!(r.give_up(), None);
        assert_eq!(
            r.observe(true),
            Observed {
                report: None,
                send: Some(req(1600, 900)),
            }
        );
    }
}
