# Scripts

La automatización por scripts está planificada, pero todavía no forma parte de la versión estable.

## En diseño

La idea es permitir recetas reproducibles para sesiones SSH:

- Conectar a un perfil.
- Enviar comandos.
- Esperar un prompt o una expresión regular.
- Pedir variables antes de ejecutar.
- Usar contraseñas desde keyring o KeePass sin guardarlas en texto plano.

## Límites previstos

Rustty no quiere convertirse en un orquestador tipo Ansible. El objetivo son automatizaciones interactivas pequeñas y revisables, útiles para tareas repetidas dentro de una terminal.

## Snippets

Antes de los scripts completos, Rustty prepara una biblioteca de snippets: comandos guardados por nombre y etiquetas para insertarlos en la terminal activa. Cuando exista esa biblioteca, los snippets viajarán con la sincronización cifrada como `snippet:<id>`.
