//! Parser **puro** del *layout string* de tmux (F1.2).
//!
//! El formato es `<checksum>,<celda>`: 4 dígitos hex (algoritmo
//! `layout_checksum` de tmux, verificado aquí contra capturas reales de
//! tmux 3.7b) y un árbol de celdas `WxH,X,Y` en **celdas de terminal**, donde
//! cada celda es una pane (`,<id>`), un split lado-a-lado (`{…}`,
//! `LAYOUT_LEFTRIGHT`) o un split arriba-abajo (`[…]`, `LAYOUT_TOPBOTTOM`).
//! Este árbol es lo que `%layout-change` trae en cada reorganización y lo que
//! la fase 4 traducirá al árbol de panes nativo del frontend.

/// Celda del layout: geometría en celdas de terminal + contenido.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutCell {
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub kind: LayoutKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutKind {
    /// Pane concreta (`%<pane>` en el resto del protocolo).
    Leaf { pane: u64 },
    Split {
        dir: SplitDir,
        children: Vec<LayoutCell>,
    },
}

/// `{}` = panes lado a lado (split «horizontal» de tmux); `[]` = una encima
/// de otra. Nombres explícitos para esquivar la ambigüedad horizontal/vertical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDir {
    LeftRight,
    TopBottom,
}

impl LayoutCell {
    /// Ids de pane en orden de aparición (izquierda→derecha, arriba→abajo).
    pub fn pane_ids(&self) -> Vec<u64> {
        let mut out = Vec::new();
        self.collect_panes(&mut out);
        out
    }

    fn collect_panes(&self, out: &mut Vec<u64>) {
        match &self.kind {
            LayoutKind::Leaf { pane } => out.push(*pane),
            LayoutKind::Split { children, .. } => {
                for child in children {
                    child.collect_panes(out);
                }
            }
        }
    }
}

/// Checksum de tmux (`layout_checksum` en `layout-custom.c`): rota y suma
/// byte a byte sobre el cuerpo (lo que sigue a la coma del checksum).
pub fn layout_checksum(body: &str) -> u16 {
    let mut csum: u16 = 0;
    for &b in body.as_bytes() {
        csum = (csum >> 1) + ((csum & 1) << 15);
        csum = csum.wrapping_add(u16::from(b));
    }
    csum
}

/// Parsea un layout string completo (`checksum,árbol`). El checksum se
/// verifica: un layout corrupto se rechaza, no se adivina.
pub fn parse_layout(input: &str) -> Result<LayoutCell, String> {
    let (checksum, body) = input
        .split_once(',')
        .ok_or_else(|| format!("layout sin checksum: {input:?}"))?;
    let expected = u16::from_str_radix(checksum, 16)
        .map_err(|_| format!("checksum no hexadecimal: {checksum:?}"))?;
    let actual = layout_checksum(body);
    if actual != expected {
        return Err(format!(
            "checksum del layout no coincide: esperado {expected:04x}, calculado {actual:04x}"
        ));
    }
    let mut cursor = Cursor {
        bytes: body.as_bytes(),
        pos: 0,
    };
    let cell = parse_cell(&mut cursor)?;
    if cursor.pos != cursor.bytes.len() {
        return Err(format!(
            "contenido inesperado tras el layout en la posición {}",
            cursor.pos
        ));
    }
    Ok(cell)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), String> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!(
                "se esperaba {:?} en la posición {}",
                char::from(b),
                self.pos
            ))
        }
    }

    fn number(&mut self) -> Result<u64, String> {
        let start = self.pos;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(format!("se esperaba un número en la posición {start}"));
        }
        // El rango lo acotó `is_ascii_digit`, así que es UTF-8 válido por
        // construcción; aun así se propaga como error de parseo — este módulo
        // procesa datos que llegan por la red y no debe tener ni un pánico.
        std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| format!("bytes no UTF-8 en la posición {start}"))?
            .parse()
            .map_err(|_| format!("número desbordado en la posición {start}"))
    }

    fn number_u32(&mut self) -> Result<u32, String> {
        let start = self.pos;
        u32::try_from(self.number()?).map_err(|_| format!("número desbordado en la posición {start}"))
    }
}

fn parse_cell(cursor: &mut Cursor) -> Result<LayoutCell, String> {
    let width = cursor.number_u32()?;
    cursor.expect(b'x')?;
    let height = cursor.number_u32()?;
    cursor.expect(b',')?;
    let x = cursor.number_u32()?;
    cursor.expect(b',')?;
    let y = cursor.number_u32()?;
    let kind = match cursor.peek() {
        Some(b',') => {
            cursor.pos += 1;
            LayoutKind::Leaf {
                pane: cursor.number()?,
            }
        }
        Some(b'{') => parse_children(cursor, b'{', b'}', SplitDir::LeftRight)?,
        Some(b'[') => parse_children(cursor, b'[', b']', SplitDir::TopBottom)?,
        other => {
            return Err(format!(
                "celda sin pane ni hijos (byte {other:?}) en la posición {}",
                cursor.pos
            ))
        }
    };
    Ok(LayoutCell {
        width,
        height,
        x,
        y,
        kind,
    })
}

fn parse_children(
    cursor: &mut Cursor,
    open: u8,
    close: u8,
    dir: SplitDir,
) -> Result<LayoutKind, String> {
    cursor.expect(open)?;
    let mut children = vec![parse_cell(cursor)?];
    while cursor.peek() == Some(b',') {
        cursor.pos += 1;
        children.push(parse_cell(cursor)?);
    }
    cursor.expect(close)?;
    if children.len() < 2 {
        return Err("split con un solo hijo: tmux nunca lo emite".to_string());
    }
    Ok(LayoutKind::Split { dir, children })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(width: u32, height: u32, x: u32, y: u32, pane: u64) -> LayoutCell {
        LayoutCell {
            width,
            height,
            x,
            y,
            kind: LayoutKind::Leaf { pane },
        }
    }

    /// Captura real: `tmux new-session -x 80 -y 24` sin splits.
    #[test]
    fn una_sola_pane() {
        let cell = parse_layout("b25d,80x24,0,0,0").expect("parsea");
        assert_eq!(cell, leaf(80, 24, 0, 0, 0));
        assert_eq!(cell.pane_ids(), vec![0]);
    }

    /// Captura real: `split-window -h` sobre la anterior (tmux 3.7b).
    #[test]
    fn dos_panes_lado_a_lado() {
        let cell = parse_layout("8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}").expect("parsea");
        assert_eq!(
            cell,
            LayoutCell {
                width: 80,
                height: 24,
                x: 0,
                y: 0,
                kind: LayoutKind::Split {
                    dir: SplitDir::LeftRight,
                    children: vec![leaf(40, 24, 0, 0, 0), leaf(39, 24, 41, 0, 1)],
                },
            }
        );
    }

    /// Captura real: `split-window -v` sobre la pane derecha → anidamiento
    /// `{…[…]}` con tres panes.
    #[test]
    fn tres_panes_anidadas() {
        let cell =
            parse_layout("d67e,80x24,0,0{40x24,0,0,0,39x24,41,0[39x12,41,0,1,39x11,41,13,2]}")
                .expect("parsea");
        assert_eq!(cell.pane_ids(), vec![0, 1, 2]);
        let LayoutKind::Split { dir, children } = &cell.kind else {
            panic!("la raíz debe ser un split");
        };
        assert_eq!(*dir, SplitDir::LeftRight);
        assert_eq!(children[0], leaf(40, 24, 0, 0, 0));
        assert_eq!(
            children[1].kind,
            LayoutKind::Split {
                dir: SplitDir::TopBottom,
                children: vec![leaf(39, 12, 41, 0, 1), leaf(39, 11, 41, 13, 2)],
            }
        );
    }

    /// Rejilla 2×2 (checksum calculado con el mismo algoritmo, que está
    /// contrastado contra tmux real en los tests de captura).
    #[test]
    fn cuatro_panes_en_rejilla() {
        let body = "80x24,0,0[80x12,0,0{40x12,0,0,0,39x12,41,0,1},80x11,0,13{40x11,0,0,2,39x11,41,13,3}]";
        let input = format!("{:04x},{body}", layout_checksum(body));
        assert_eq!(input, format!("f3b4,{body}"));
        let cell = parse_layout(&input).expect("parsea");
        assert_eq!(cell.pane_ids(), vec![0, 1, 2, 3]);
    }

    #[test]
    fn checksum_incorrecto_se_rechaza() {
        let err = parse_layout("0000,80x24,0,0,0").unwrap_err();
        assert!(err.contains("checksum"), "{err}");
    }

    #[test]
    fn layouts_malformados_dan_error_no_panico() {
        for input in [
            "",
            "b25d",
            "zzzz,80x24,0,0,0",
            "8205,80x24,0,0{40x24,0,0,0",
            "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}basura",
            "b25d,80x24,0,0",
            "b25d,80x24",
        ] {
            let with_checksum = if input.contains(',') && !input.starts_with("zzzz") {
                // Recalcula el checksum para que el error sea del árbol, no
                // del checksum.
                let body = input.split_once(',').unwrap().1;
                format!("{:04x},{body}", layout_checksum(body))
            } else {
                input.to_string()
            };
            assert!(
                parse_layout(&with_checksum).is_err(),
                "debería fallar: {with_checksum:?}"
            );
        }
    }

    #[test]
    fn split_de_un_solo_hijo_se_rechaza() {
        let body = "80x24,0,0{80x24,0,0,1}";
        let input = format!("{:04x},{body}", layout_checksum(body));
        let err = parse_layout(&input).unwrap_err();
        assert!(err.contains("un solo hijo"), "{err}");
    }
}
