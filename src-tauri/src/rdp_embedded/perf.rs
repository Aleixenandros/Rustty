//! Perfil de rendimiento de una sesión integrada: lo que se pide al servidor
//! para gastar menos ancho de banda (fondo, animaciones, compresión…).
//!
//! Es lo mismo que hace el «Optimizar velocidad» de otros clientes de escritorio
//! remoto: quitar del remoto lo que más píxeles cambia sin aportar nada.

use ironrdp_pdu::gcc::ConnectionType;
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerfProfile {
    /// Conexiones lentas: sin fondo, sin temas, sin suavizado de fuentes y con
    /// la compresión más fuerte.
    Speed,
    /// Sin fondo ni animaciones, pero con suavizado de fuentes y temas.
    #[default]
    Balanced,
    /// Como en local: fondo, efectos y composición. Sin compresión (en una LAN
    /// gasta CPU para nada).
    Quality,
}

/// Lo que el perfil cambia en la configuración del conector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfSettings {
    pub flags: PerformanceFlags,
    pub connection_type: ConnectionType,
    pub compression: Option<CompressionType>,
}

impl PerfProfile {
    #[must_use]
    pub fn settings(self) -> PerfSettings {
        let lean = PerformanceFlags::DISABLE_WALLPAPER
            | PerformanceFlags::DISABLE_FULLWINDOWDRAG
            | PerformanceFlags::DISABLE_MENUANIMATIONS
            | PerformanceFlags::DISABLE_CURSOR_SHADOW;
        match self {
            Self::Speed => PerfSettings {
                flags: lean | PerformanceFlags::DISABLE_THEMING,
                connection_type: ConnectionType::BroadbandLow,
                compression: Some(CompressionType::Rdp61),
            },
            Self::Balanced => PerfSettings {
                flags: lean | PerformanceFlags::ENABLE_FONT_SMOOTHING,
                connection_type: ConnectionType::BroadbandHigh,
                compression: Some(CompressionType::K64),
            },
            Self::Quality => PerfSettings {
                flags: PerformanceFlags::ENABLE_FONT_SMOOTHING
                    | PerformanceFlags::ENABLE_DESKTOP_COMPOSITION,
                connection_type: ConnectionType::Lan,
                compression: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perfil_por_defecto_es_equilibrado() {
        assert_eq!(PerfProfile::default(), PerfProfile::Balanced);
        let p: PerfProfile = serde_json::from_str("\"speed\"").unwrap();
        assert_eq!(p, PerfProfile::Speed);
    }

    #[test]
    fn velocidad_quita_fondo_y_comprime() {
        let s = PerfProfile::Speed.settings();
        assert!(s.flags.contains(PerformanceFlags::DISABLE_WALLPAPER));
        assert!(!s.flags.contains(PerformanceFlags::ENABLE_FONT_SMOOTHING));
        assert!(s.compression.is_some());
    }

    #[test]
    fn calidad_deja_fondo_y_no_comprime() {
        let s = PerfProfile::Quality.settings();
        assert!(!s.flags.contains(PerformanceFlags::DISABLE_WALLPAPER));
        assert_eq!(s.compression, None);
        assert_eq!(s.connection_type, ConnectionType::Lan);
    }

    #[test]
    fn equilibrado_quita_fondo_y_mantiene_suavizado() {
        let s = PerfProfile::Balanced.settings();
        assert!(s.flags.contains(PerformanceFlags::DISABLE_WALLPAPER));
        assert!(s.flags.contains(PerformanceFlags::ENABLE_FONT_SMOOTHING));
    }
}
