// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = rustty_lib::cli::try_run_from_env() {
        std::process::exit(code);
    }
    rustty_lib::run()
}
