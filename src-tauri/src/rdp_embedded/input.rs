//! Lote binario de entrada (ratón y teclado) que manda el canvas.
//!
//! El frontend agrupa los eventos y los envía como cuerpo crudo de
//! `rdp_embed_input`. Aquí se decodifican a operaciones de `ironrdp-input`.
//! **Nunca** se registran: llevan pulsaciones de teclado.
//!
//! ## Formato (little endian), eventos concatenados
//!
//! | tipo | evento          | cuerpo                                      |
//! |------|-----------------|---------------------------------------------|
//! | 1    | mover ratón     | `x, y: u16` (píxeles del escritorio remoto) |
//! | 2    | botón           | `boton: u8` (0..=4, como `MouseEvent.button`), `pulsado: u8` |
//! | 3    | rueda           | `vertical: u8`, `unidades: i16`             |
//! | 4    | tecla           | `scancode: u16` (bit `0xE000` = extendida), `pulsada: u8` |
//! | 5    | carácter        | `codepoint: u32`, `pulsado: u8`             |
//! | 6    | soltar todo     | —                                           |
//! | 7    | sincronizar     | `bloqueos: u8` (bit0 Bloq Despl, bit1 Bloq Num, bit2 Bloq Mayús, bit3 Kana) |

use ironrdp_input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};

/// Tamaño máximo de un lote. Un lote legítimo son unos pocos eventos; esto
/// solo corta un cuerpo absurdo antes de recorrerlo.
pub const MAX_BATCH_BYTES: usize = 64 * 1024;

/// Evento decodificado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// Operación para la base de datos de estado de `ironrdp-input`.
    Op(OpKind),
    /// Soltar todo lo pulsado (pérdida de foco del canvas).
    ReleaseAll,
    /// Estado de los bloqueos (Bloq Mayús, etc.).
    Sync {
        scroll: bool,
        num: bool,
        caps: bool,
        kana: bool,
    },
}

/// Espejo comparable de `ironrdp_input::Operation` (que no implementa `PartialEq`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    MouseMove { x: u16, y: u16 },
    MouseButton { button: u8, pressed: bool },
    Wheel { vertical: bool, units: i16 },
    Key { scancode: u16, pressed: bool },
    Unicode { ch: char, pressed: bool },
}

impl OpKind {
    /// Convierte a la operación de `ironrdp-input`. `None` para un botón de
    /// ratón que no existe.
    #[must_use]
    pub fn to_operation(self) -> Option<Operation> {
        Some(match self {
            Self::MouseMove { x, y } => Operation::MouseMove(MousePosition { x, y }),
            Self::MouseButton { button, pressed } => {
                let b = MouseButton::from_web_button(button)?;
                if pressed {
                    Operation::MouseButtonPressed(b)
                } else {
                    Operation::MouseButtonReleased(b)
                }
            }
            Self::Wheel { vertical, units } => Operation::WheelRotations(WheelRotations {
                is_vertical: vertical,
                rotation_units: units,
            }),
            Self::Key { scancode, pressed } => {
                let sc = Scancode::from_u16(scancode);
                if pressed {
                    Operation::KeyPressed(sc)
                } else {
                    Operation::KeyReleased(sc)
                }
            }
            Self::Unicode { ch, pressed } => {
                if pressed {
                    Operation::UnicodeKeyPressed(ch)
                } else {
                    Operation::UnicodeKeyReleased(ch)
                }
            }
        })
    }
}

/// Lector sencillo sobre el cuerpo del lote.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u16(&mut self) -> Option<u16> {
        let b = self.buf.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Option<u32> {
        let b = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Decodifica un lote completo. Un lote mal formado se rechaza **entero**: no
/// se aplica a medias una secuencia de teclas.
pub fn decode_batch(buf: &[u8]) -> Result<Vec<InputEvent>, &'static str> {
    if buf.len() > MAX_BATCH_BYTES {
        return Err("lote de entrada demasiado grande");
    }
    let mut r = Reader { buf, pos: 0 };
    let mut out = Vec::new();
    let bad = "lote de entrada mal formado";
    while r.pos < buf.len() {
        let kind = r.u8().ok_or(bad)?;
        let ev = match kind {
            1 => InputEvent::Op(OpKind::MouseMove {
                x: r.u16().ok_or(bad)?,
                y: r.u16().ok_or(bad)?,
            }),
            2 => {
                let button = r.u8().ok_or(bad)?;
                if button > 4 {
                    return Err(bad);
                }
                InputEvent::Op(OpKind::MouseButton {
                    button,
                    pressed: r.u8().ok_or(bad)? != 0,
                })
            }
            3 => {
                let vertical = r.u8().ok_or(bad)? != 0;
                let units = i16::from_le_bytes(r.u16().ok_or(bad)?.to_le_bytes());
                InputEvent::Op(OpKind::Wheel { vertical, units })
            }
            4 => InputEvent::Op(OpKind::Key {
                scancode: r.u16().ok_or(bad)?,
                pressed: r.u8().ok_or(bad)? != 0,
            }),
            5 => {
                let ch = char::from_u32(r.u32().ok_or(bad)?).ok_or(bad)?;
                InputEvent::Op(OpKind::Unicode {
                    ch,
                    pressed: r.u8().ok_or(bad)? != 0,
                })
            }
            6 => InputEvent::ReleaseAll,
            7 => {
                let f = r.u8().ok_or(bad)?;
                InputEvent::Sync {
                    scroll: f & 1 != 0,
                    num: f & 2 != 0,
                    caps: f & 4 != 0,
                    kana: f & 8 != 0,
                }
            }
            _ => return Err(bad),
        };
        out.push(ev);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_un_lote_mixto() {
        let mut b = vec![1, 0x10, 0, 0x20, 0]; // mover a (16, 32)
        b.extend([2, 0, 1]); // botón izquierdo pulsado
        b.extend([3, 1, 0x88, 0xFF]); // rueda vertical -120
        b.extend([4, 0x1D, 0xE0, 1]); // Ctrl derecho (extendida) pulsado
        b.extend([5, 0xE9, 0, 0, 0, 0]); // 'é' soltado
        b.extend([6]);
        b.extend([7, 0b0110]);
        let evs = decode_batch(&b).unwrap();
        assert_eq!(
            evs,
            vec![
                InputEvent::Op(OpKind::MouseMove { x: 16, y: 32 }),
                InputEvent::Op(OpKind::MouseButton {
                    button: 0,
                    pressed: true
                }),
                InputEvent::Op(OpKind::Wheel {
                    vertical: true,
                    units: -120
                }),
                InputEvent::Op(OpKind::Key {
                    scancode: 0xE01D,
                    pressed: true
                }),
                InputEvent::Op(OpKind::Unicode {
                    ch: 'é',
                    pressed: false
                }),
                InputEvent::ReleaseAll,
                InputEvent::Sync {
                    scroll: false,
                    num: true,
                    caps: true,
                    kana: false
                },
            ]
        );
    }

    #[test]
    fn rechaza_lotes_mal_formados() {
        assert!(decode_batch(&[1, 0, 0]).is_err()); // truncado
        assert!(decode_batch(&[9]).is_err()); // tipo desconocido
        assert!(decode_batch(&[2, 7, 1]).is_err()); // botón inexistente
        assert!(decode_batch(&[5, 0, 0xD8, 0, 0, 1]).is_err()); // surrogate
        assert!(decode_batch(&vec![6; MAX_BATCH_BYTES + 1]).is_err());
        assert_eq!(decode_batch(&[]).unwrap(), vec![]);
    }

    #[test]
    fn convierte_a_operaciones_de_ironrdp() {
        let op = OpKind::Key {
            scancode: 0xE04B,
            pressed: true,
        }
        .to_operation();
        assert!(matches!(op, Some(Operation::KeyPressed(sc)) if sc.as_u16() == 0xE04B));
        assert!(OpKind::MouseButton {
            button: 4,
            pressed: true
        }
        .to_operation()
        .is_some());
    }
}
