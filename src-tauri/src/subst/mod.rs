//! Motor de sustitución de plantillas (`${...}`).
//!
//! Fase 1: parser de la gramática del contrato, resolución de variables
//! internas (`host`/`port`/`user`/`profileName`/`workspace`/`date`/`time`) y de
//! `${env:VAR}`. Los namespaces `var`/`secret`/`master`/`ask`/`cmd` se
//! reconocen en la gramática pero quedan sin resolver hasta las fases
//! siguientes, a través del trait `Resolver`.
//!
//! La API pública del motor (parser, `substitute`, `Resolver`, `SubstContext`)
//! se cablea en fases posteriores (3+): hasta entonces no tiene llamantes en el
//! binario, por lo que silenciamos los avisos de código sin usar a nivel de
//! módulo. Los tests sí ejercitan toda la superficie.
#![allow(dead_code, unused_imports)]

pub mod engine;
pub mod redact;
pub mod types;

pub use engine::{parse, substitute};
pub use redact::{redact_secrets, REDACTED};
pub use types::{DefaultResolver, InternalVar, Marker, Resolver, SubstContext};
