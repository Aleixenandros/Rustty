//! Protocolo binario de fotogramas hacia el canvas y acumulador de «daños».
//!
//! El backend no manda pantallas enteras: manda los **rectángulos que han
//! cambiado** (dirty rects) desde el último envío. Cada mensaje viaja por el
//! `Channel<Response>` de la sesión como bytes crudos (sin base64 ni JSON).
//!
//! ## Formato (little endian)
//!
//! Cabecera común: `tipo: u8`, `seq: u32`.
//!
//! | tipo | nombre           | cuerpo                                                     |
//! |------|------------------|------------------------------------------------------------|
//! | 1    | `RECTS`          | `n: u16`, y `n` veces `x, y, w, h: u16` + `w*h*4` bytes RGBA |
//! | 2    | `DESKTOP_SIZE`   | `w, h: u16`                                                |
//! | 3    | `POINTER_BITMAP` | `w, h, hotspot_x, hotspot_y: u16` + `w*h*4` bytes RGBA     |
//! | 4    | `POINTER_DEFAULT`| —                                                          |
//! | 5    | `POINTER_HIDDEN` | —                                                          |
//!
//! El alfa de los píxeles de escritorio se fuerza a `0xFF`: el framebuffer de
//! IronRDP no garantiza alfa opaco y `putImageData` lo respetaría tal cual.
//!
//! ## Contrapresión
//!
//! El frontend confirma (`rdp_embed_ack`) el `seq` más alto que ha **pintado**.
//! Con [`MAX_IN_FLIGHT`] mensajes sin confirmar, el backend deja de enviar y
//! sigue acumulando daños en [`Damage`], que está acotado: pasado
//! [`MAX_PENDING_RECTS`] rectángulos funde la pareja que menos área añade, y si el área
//! pendiente supera [`FULL_FRAME_RATIO`] de la pantalla manda la pantalla
//! entera. Así la memoria no crece aunque el webview vaya lento: como mucho un
//! framebuffer y la copia de lo pendiente.

/// Mensajes de fotogramas sin confirmar a partir de los cuales se deja de enviar.
pub const MAX_IN_FLIGHT: u32 = 2;
/// Rectángulos pendientes a partir de los cuales se funden por parejas.
pub const MAX_PENDING_RECTS: usize = 64;
/// Dos rectángulos se funden al llegar si su envolvente no pasa de esta
/// proporción de la suma de sus áreas (×10: 13 = 1,3). Junta las teselas
/// vecinas de RemoteFX en bandas sin arrastrar píxeles que no cambiaron.
const CHEAP_MERGE_NUM: u64 = 13;
const CHEAP_MERGE_DEN: u64 = 10;
/// Fracción del área de pantalla a partir de la cual se manda la pantalla entera.
pub const FULL_FRAME_RATIO: f64 = 0.6;

pub const MSG_RECTS: u8 = 1;
pub const MSG_DESKTOP_SIZE: u8 = 2;
pub const MSG_POINTER_BITMAP: u8 = 3;
pub const MSG_POINTER_DEFAULT: u8 = 4;
pub const MSG_POINTER_HIDDEN: u8 = 5;

/// Rectángulo exclusivo (`x + w` queda fuera) en píxeles del escritorio remoto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    /// Desde los bordes **inclusivos** que da IronRDP (`right`/`bottom` incluidos).
    #[must_use]
    pub fn from_inclusive(left: u16, top: u16, right: u16, bottom: u16) -> Option<Self> {
        if right < left || bottom < top {
            return None;
        }
        Some(Self {
            x: left,
            y: top,
            w: right - left + 1,
            h: bottom - top + 1,
        })
    }

    fn right(self) -> u32 {
        u32::from(self.x) + u32::from(self.w)
    }

    fn bottom(self) -> u32 {
        u32::from(self.y) + u32::from(self.h)
    }

    fn area(self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }

    /// Recorta el rectángulo a una pantalla de `width × height`. `None` si queda
    /// fuera (puede pasar con fotogramas del tamaño anterior tras un resize).
    #[must_use]
    pub fn clamp_to(self, width: u16, height: u16) -> Option<Self> {
        if self.x >= width || self.y >= height || self.w == 0 || self.h == 0 {
            return None;
        }
        let right = self.right().min(u32::from(width));
        let bottom = self.bottom().min(u32::from(height));
        Some(Self {
            x: self.x,
            y: self.y,
            w: u16::try_from(right - u32::from(self.x)).ok()?,
            h: u16::try_from(bottom - u32::from(self.y)).ok()?,
        })
    }

    fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Self {
            x,
            y,
            w: u16::try_from(right - u32::from(x)).unwrap_or(u16::MAX),
            h: u16::try_from(bottom - u32::from(y)).unwrap_or(u16::MAX),
        }
    }

    /// Área que se copiaría de más al fundir los dos (0 si encajan justos).
    fn merge_waste(self, other: Self) -> u64 {
        self.union(other)
            .area()
            .saturating_sub(self.area() + other.area())
    }

    fn cheap_merge(self, other: Self) -> bool {
        self.union(other).area() * CHEAP_MERGE_DEN
            <= (self.area() + other.area()) * CHEAP_MERGE_NUM
    }

    fn contains(self, other: Self) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }
}

/// Daños pendientes de enviar, acotados en número y fundidos cuando hace falta.
#[derive(Debug, Default)]
pub struct Damage {
    rects: Vec<Rect>,
}

impl Damage {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    /// Vacía lo pendiente (p. ej. tras un cambio de resolución, que repinta todo).
    pub fn clear(&mut self) {
        self.rects.clear();
    }

    /// Añade un rectángulo. Ignora los que ya cubre otro pendiente, funde los
    /// vecinos que encajan casi justos y, pasado el límite, funde la pareja que
    /// menos área añade. Nunca junta dos esquinas lejanas en la pantalla entera
    /// mientras haya parejas más baratas.
    pub fn add(&mut self, rect: Rect) {
        if rect.w == 0 || rect.h == 0 || self.rects.iter().any(|r| r.contains(rect)) {
            return;
        }
        let mut rect = rect;
        while let Some(i) = self.rects.iter().position(|r| r.cheap_merge(rect)) {
            rect = self.rects.swap_remove(i).union(rect);
        }
        self.rects.retain(|r| !rect.contains(*r));
        self.rects.push(rect);
        while self.rects.len() > MAX_PENDING_RECTS {
            self.merge_cheapest_pair();
        }
    }

    fn merge_cheapest_pair(&mut self) {
        let mut best: Option<(usize, usize, u64)> = None;
        for i in 0..self.rects.len() {
            for j in (i + 1)..self.rects.len() {
                let waste = self.rects[i].merge_waste(self.rects[j]);
                if best.is_none_or(|(_, _, w)| waste < w) {
                    best = Some((i, j, waste));
                }
            }
        }
        if let Some((i, j, _)) = best {
            let other = self.rects.swap_remove(j);
            let merged = self.rects[i].union(other);
            self.rects[i] = merged;
            self.rects.retain(|r| r == &merged || !merged.contains(*r));
        }
    }

    /// Saca lo pendiente recortado a la pantalla actual. Si cubre más de
    /// [`FULL_FRAME_RATIO`] del área, devuelve la pantalla entera: un único
    /// rectángulo grande sale más barato que muchos medianos.
    pub fn take(&mut self, width: u16, height: u16) -> Vec<Rect> {
        let rects: Vec<Rect> = self
            .rects
            .drain(..)
            .filter_map(|r| r.clamp_to(width, height))
            .collect();
        let screen = u64::from(width) * u64::from(height);
        let pending: u64 = rects.iter().map(|r| r.area()).sum();
        #[allow(clippy::cast_precision_loss)]
        if screen > 0 && pending as f64 > screen as f64 * FULL_FRAME_RATIO {
            return vec![Rect {
                x: 0,
                y: 0,
                w: width,
                h: height,
            }];
        }
        rects
    }
}

/// Numerador de mensajes y control de los que están sin confirmar.
#[derive(Debug, Default)]
pub struct Flow {
    sent: u32,
    acked: u32,
}

impl Flow {
    /// Siguiente número de secuencia (cuenta como enviado).
    pub fn next_seq(&mut self) -> u32 {
        self.sent = self.sent.wrapping_add(1);
        self.sent
    }

    /// Registra la confirmación del frontend. Se queda con la más alta; las
    /// confirmaciones que vengan de un futuro imposible se ignoran.
    pub fn ack(&mut self, seq: u32) {
        let ahead = seq.wrapping_sub(self.acked);
        let in_flight = self.sent.wrapping_sub(self.acked);
        if ahead != 0 && ahead <= in_flight {
            self.acked = seq;
        }
    }

    #[must_use]
    pub fn in_flight(&self) -> u32 {
        self.sent.wrapping_sub(self.acked)
    }

    #[must_use]
    pub fn can_send(&self) -> bool {
        self.in_flight() < MAX_IN_FLIGHT
    }
}

fn header(kind: u8, seq: u32, capacity: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + capacity);
    out.push(kind);
    out.extend_from_slice(&seq.to_le_bytes());
    out
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Codifica un mensaje `RECTS` copiando los píxeles de `rects` desde un
/// framebuffer RGBA32 (`stride` bytes por fila) y forzando alfa opaco.
#[must_use]
pub fn encode_rects(seq: u32, rects: &[Rect], framebuffer: &[u8], stride: usize) -> Vec<u8> {
    let payload: usize = rects
        .iter()
        .map(|r| 8 + usize::from(r.w) * usize::from(r.h) * 4)
        .sum();
    let mut out = header(MSG_RECTS, seq, 2 + payload);
    push_u16(&mut out, u16::try_from(rects.len()).unwrap_or(u16::MAX));
    for rect in rects.iter().take(usize::from(u16::MAX)) {
        push_u16(&mut out, rect.x);
        push_u16(&mut out, rect.y);
        push_u16(&mut out, rect.w);
        push_u16(&mut out, rect.h);
        let row_bytes = usize::from(rect.w) * 4;
        for row in 0..usize::from(rect.h) {
            let start = (usize::from(rect.y) + row) * stride + usize::from(rect.x) * 4;
            let end = start + row_bytes;
            match framebuffer.get(start..end) {
                Some(src) => {
                    let at = out.len();
                    out.extend_from_slice(src);
                    for alpha in out[at..].iter_mut().skip(3).step_by(4) {
                        *alpha = 0xFF;
                    }
                }
                // Fuera del framebuffer (no debería pasar tras `clamp_to`):
                // relleno negro para que el mensaje siga bien formado.
                None => {
                    out.extend(std::iter::repeat_n([0, 0, 0, 0xFF], usize::from(rect.w)).flatten())
                }
            }
        }
    }
    out
}

#[must_use]
pub fn encode_desktop_size(seq: u32, width: u16, height: u16) -> Vec<u8> {
    let mut out = header(MSG_DESKTOP_SIZE, seq, 4);
    push_u16(&mut out, width);
    push_u16(&mut out, height);
    out
}

#[must_use]
pub fn encode_pointer_bitmap(
    seq: u32,
    width: u16,
    height: u16,
    hotspot_x: u16,
    hotspot_y: u16,
    rgba: &[u8],
) -> Vec<u8> {
    let mut out = header(MSG_POINTER_BITMAP, seq, 8 + rgba.len());
    push_u16(&mut out, width);
    push_u16(&mut out, height);
    push_u16(&mut out, hotspot_x);
    push_u16(&mut out, hotspot_y);
    out.extend_from_slice(rgba);
    out
}

#[must_use]
pub fn encode_simple(kind: u8, seq: u32) -> Vec<u8> {
    header(kind, seq, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: u16, y: u16, w: u16, h: u16) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn rect_inclusivo_a_exclusivo() {
        assert_eq!(
            Rect::from_inclusive(10, 20, 19, 29),
            Some(r(10, 20, 10, 10))
        );
        assert_eq!(Rect::from_inclusive(5, 5, 5, 5), Some(r(5, 5, 1, 1)));
        assert_eq!(Rect::from_inclusive(5, 5, 4, 5), None);
    }

    #[test]
    fn recorte_a_pantalla() {
        assert_eq!(
            r(90, 90, 20, 20).clamp_to(100, 100),
            Some(r(90, 90, 10, 10))
        );
        assert_eq!(r(100, 0, 5, 5).clamp_to(100, 100), None);
        assert_eq!(r(0, 0, 0, 5).clamp_to(100, 100), None);
    }

    #[test]
    fn danos_ignora_cubiertos_y_absorbe_contenidos() {
        let mut d = Damage::default();
        d.add(r(0, 0, 50, 50));
        d.add(r(10, 10, 5, 5)); // cubierto
        assert_eq!(d.take(1000, 1000), vec![r(0, 0, 50, 50)]);

        d.add(r(10, 10, 5, 5));
        d.add(r(0, 0, 50, 50)); // absorbe al anterior
        assert_eq!(d.take(1000, 1000), vec![r(0, 0, 50, 50)]);
    }

    fn covered(rects: &[Rect], x: u16, y: u16) -> bool {
        rects.iter().any(|q| q.contains(r(x, y, 1, 1)))
    }

    #[test]
    fn danos_acotados_no_pasan_del_limite_ni_pierden_nada() {
        let mut d = Damage::default();
        let n = u16::try_from(MAX_PENDING_RECTS).unwrap() * 2;
        for i in 0..n {
            d.add(r(i * 3, 0, 1, 1));
        }
        let out = d.take(4000, 4000);
        assert!(out.len() <= MAX_PENDING_RECTS);
        for i in 0..n {
            assert!(covered(&out, i * 3, 0), "falta ({}, 0)", i * 3);
        }
    }

    #[test]
    fn teselas_vecinas_se_funden_en_banda() {
        let mut d = Damage::default();
        for i in 0..4 {
            d.add(r(i * 64, 0, 64, 64));
        }
        assert_eq!(d.take(1000, 1000), vec![r(0, 0, 256, 64)]);
    }

    #[test]
    fn dos_esquinas_no_se_funden_en_la_pantalla_entera() {
        // Muchos cambios pequeños en dos esquinas opuestas: al pasar del límite
        // se funden dentro de cada esquina, no en una envolvente de 1000×1000.
        let mut d = Damage::default();
        for i in 0..40u16 {
            d.add(r((i % 8) * 4, (i / 8) * 4, 2, 2));
            d.add(r(960 + (i % 8) * 4, 960 + (i / 8) * 4, 2, 2));
        }
        let out = d.take(1000, 1000);
        let area: u64 = out.iter().map(|q| q.area()).sum();
        assert!(area < 10_000, "área enviada {area}");
        assert!(covered(&out, 0, 0) && covered(&out, 960, 960));
    }

    #[test]
    fn danos_grandes_mandan_pantalla_entera() {
        let mut d = Damage::default();
        d.add(r(0, 0, 100, 70));
        assert_eq!(d.take(100, 100), vec![r(0, 0, 100, 100)]);
        d.add(r(0, 0, 10, 10));
        assert_eq!(d.take(100, 100), vec![r(0, 0, 10, 10)]);
        assert!(d.is_empty());
    }

    #[test]
    fn flujo_limita_mensajes_sin_confirmar() {
        let mut f = Flow::default();
        assert!(f.can_send());
        let a = f.next_seq();
        let b = f.next_seq();
        assert!(!f.can_send());
        f.ack(a);
        assert!(f.can_send());
        // Una confirmación del futuro no vale.
        f.ack(b + 10);
        assert_eq!(f.in_flight(), 1);
        f.ack(b);
        assert_eq!(f.in_flight(), 0);
        // Una antigua tampoco hace retroceder.
        f.ack(a);
        assert_eq!(f.in_flight(), 0);
    }

    #[test]
    fn codifica_rects_con_alfa_opaco() {
        // Framebuffer 4×2, stride 16, alfa a 0 en todos los píxeles.
        let mut fb = vec![0u8; 4 * 2 * 4];
        for (i, px) in fb.chunks_mut(4).enumerate() {
            px[0] = u8::try_from(i).unwrap();
        }
        let msg = encode_rects(7, &[r(1, 1, 2, 1)], &fb, 16);
        assert_eq!(msg[0], MSG_RECTS);
        assert_eq!(u32::from_le_bytes(msg[1..5].try_into().unwrap()), 7);
        assert_eq!(u16::from_le_bytes([msg[5], msg[6]]), 1);
        assert_eq!(&msg[7..15], &[1, 0, 1, 0, 2, 0, 1, 0]);
        // Píxeles (1,1) y (2,1) = índices 5 y 6, alfa forzado.
        assert_eq!(&msg[15..], &[5, 0, 0, 0xFF, 6, 0, 0, 0xFF]);
    }

    #[test]
    fn codifica_mensajes_de_control() {
        assert_eq!(
            encode_desktop_size(1, 1920, 1080),
            vec![2, 1, 0, 0, 0, 0x80, 7, 0x38, 4]
        );
        assert_eq!(encode_simple(MSG_POINTER_HIDDEN, 3), vec![5, 3, 0, 0, 0]);
        let p = encode_pointer_bitmap(2, 1, 1, 0, 0, &[1, 2, 3, 4]);
        assert_eq!(p.len(), 5 + 8 + 4);
    }
}
