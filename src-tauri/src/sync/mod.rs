//! Sync between computers through a small server (sync-server/), end-to-end
//! encrypted. See engine.rs for how a sync round works and crypto.rs for what
//! the server can (not) see.

pub mod client;
pub mod crypto;
pub mod engine;

use client::{Client, Device};
use crypto::VaultKey;
use engine::{Engine, Event, Status};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const KEYCHAIN_SERVICE: &str = "app.joyce.writer";

static APP: OnceLock<AppHandle> = OnceLock::new();
static ENGINE: Mutex<Option<Arc<Engine>>> = Mutex::new(None);
static LAST_STATUS: Mutex<Option<Status>> = Mutex::new(None);

/// What this computer remembers about its sync setup. Secrets live in the OS store.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    server: String,
    vault_id: String,
    device_id: String,
    root: String,
}

fn sync_dir() -> Result<PathBuf, String> {
    let app = APP.get().ok_or("Not ready")?;
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sync"))
}

fn load_config() -> Option<Config> {
    let s = std::fs::read_to_string(sync_dir().ok()?.join("config.json")).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_config(c: &Config) -> Result<(), String> {
    let dir = sync_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("config.json"), serde_json::to_string_pretty(c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn secret(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

fn store_secrets(token: &str, key: &VaultKey) -> Result<(), String> {
    secret("sync-token")?.set_password(token).map_err(|e| e.to_string())?;
    secret("sync-key")?.set_password(&key.to_base64()).map_err(|e| e.to_string())
}

fn load_secrets() -> Result<(String, VaultKey), String> {
    let token = secret("sync-token")?.get_password().map_err(|e| e.to_string())?;
    let key = VaultKey::from_base64(&secret("sync-key")?.get_password().map_err(|e| e.to_string())?)?;
    Ok((token, key))
}

fn forget_secrets() {
    for account in ["sync-token", "sync-key"] {
        if let Ok(e) = secret(account) {
            let _ = e.delete_credential();
        }
    }
}

/// This computer's name as other computers will see it, e.g. in conflict copies.
pub fn device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let host = host.trim_end_matches(".local").trim_end_matches(".lan");
    if host.is_empty() { "Computer".into() } else { host.replace('-', " ") }
}

fn current() -> Option<Arc<Engine>> {
    ENGINE.lock().ok()?.clone()
}

fn emit(event: Event) {
    let Some(app) = APP.get() else { return };
    match event {
        Event::Status(s) => {
            if let Ok(mut last) = LAST_STATUS.lock() {
                *last = Some(s.clone());
            }
            let _ = app.emit("sync://status", s);
        }
        Event::Changed(paths) => {
            let _ = app.emit("sync://changed", paths);
        }
    }
}

fn start(config: &Config, token: String, key: VaultKey) -> Result<(), String> {
    stop_engine();
    let state_path = sync_dir()?.join(format!("state-{}.json", config.vault_id));
    let engine = Engine::new(
        PathBuf::from(&config.root),
        device_name(),
        key,
        Client::new(&config.server, &token),
        state_path,
        Arc::new(emit),
    );
    *ENGINE.lock().map_err(|e| e.to_string())? = Some(engine.clone());
    tauri::async_runtime::spawn(engine.run());
    Ok(())
}

fn stop_engine() {
    if let Ok(mut slot) = ENGINE.lock() {
        if let Some(e) = slot.take() {
            e.stop();
        }
    }
}

/// Called at startup: resumes syncing if this computer was set up for it.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    if let Some(config) = load_config() {
        match load_secrets() {
            Ok((token, key)) => {
                let _ = start(&config, token, key);
            }
            Err(e) => emit(Event::Status(Status::Error { message: format!("Sync keys are missing: {e}") })),
        }
    }
}

/// Local files changed (Joyce saved, created, renamed or deleted something).
pub fn nudge() {
    if let Some(e) = current() {
        e.nudge();
    }
}

// --- Commands ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    enabled: bool,
    server: Option<String>,
    root: Option<String>,
    device_name: String,
    status: Option<Status>,
}

#[tauri::command]
pub fn sync_info() -> SyncInfo {
    let config = load_config();
    SyncInfo {
        enabled: config.is_some(),
        server: config.as_ref().map(|c| c.server.clone()),
        root: config.map(|c| c.root),
        device_name: device_name(),
        status: LAST_STATUS.lock().ok().and_then(|s| s.clone()),
    }
}

/// First computer: creates the vault and uploads the writing folder.
#[tauri::command]
pub async fn sync_enable(server: String, root: String) -> Result<(), String> {
    let created = client::create_vault(&server, &device_name()).await?;
    let key = VaultKey::generate();
    store_secrets(&created.token, &key)?;
    let config = Config { server: client::normalize_server(&server), vault_id: created.vault_id, device_id: created.device_id, root };
    save_config(&config)?;
    start(&config, created.token, key)
}

/// Another computer: joins with a pairing code made on a computer that's already syncing.
#[tauri::command]
pub async fn sync_join(server: String, code: String, root: String) -> Result<(), String> {
    // Deliberately slow key derivation; keep it off the async threads.
    let (lookup, pairing_key) = tauri::async_runtime::spawn_blocking(move || crypto::pairing_keys(&code))
        .await
        .map_err(|e| e.to_string())??;
    let claimed = client::claim_pairing(&server, &lookup, &device_name()).await?;
    let key = crypto::open_from_pairing(&pairing_key, claimed.sealed.as_deref().unwrap_or_default())?;
    store_secrets(&claimed.token, &key)?;
    let config = Config { server: client::normalize_server(&server), vault_id: claimed.vault_id, device_id: claimed.device_id, root };
    save_config(&config)?;
    start(&config, claimed.token, key)
}

#[derive(Serialize)]
pub struct PairingCode {
    code: String,
    expires: u64,
}

/// A one-time code for adding another computer. The vault key travels sealed
/// with it; the code itself never reaches the server.
#[tauri::command]
pub async fn sync_pairing_code() -> Result<PairingCode, String> {
    let engine = current().ok_or("Sync isn't on")?;
    let code = crypto::new_pairing_code();
    let c = code.clone();
    let (lookup, pairing_key) = tauri::async_runtime::spawn_blocking(move || crypto::pairing_keys(&c))
        .await
        .map_err(|e| e.to_string())??;
    let sealed = crypto::seal_for_pairing(&pairing_key, engine.key());
    let expires = engine.client().create_pairing(&lookup, &sealed).await?;
    Ok(PairingCode { code, expires })
}

#[tauri::command]
pub async fn sync_devices() -> Result<Vec<Device>, String> {
    Ok(current().ok_or("Sync isn't on")?.client().devices().await?)
}

#[tauri::command]
pub async fn sync_remove_device(id: String) -> Result<(), String> {
    Ok(current().ok_or("Sync isn't on")?.client().remove_device(&id).await?)
}

/// Stops syncing on this computer. Files stay where they are; the other
/// computers keep syncing with each other.
#[tauri::command]
pub async fn sync_disable() -> Result<(), String> {
    if let (Some(engine), Some(config)) = (current(), load_config()) {
        // Best effort: tell the server this computer is gone.
        let _ = engine.client().remove_device(&config.device_id).await;
    }
    stop_engine();
    forget_secrets();
    if let Ok(dir) = sync_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Ok(mut last) = LAST_STATUS.lock() {
        *last = None;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_now() {
    if let Some(e) = current() {
        e.nudge();
    }
}
