mod worker;

use base64::Engine as _;
use std::fs;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use rfd::FileDialog;
use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_single_instance;
use uuid::Uuid;
use worker::{
    AppStateStore, HealthState, LogLevel, LogRecord, WorkerHandle, WorkerSettings, WorkerSnapshot,
};

struct RuntimeState {
    store: Arc<Mutex<AppStateStore>>,
    worker: Mutex<Option<WorkerHandle>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatus {
    current_version: String,
    latest_version: Option<String>,
    is_update_available: bool,
    download_url: String,
    release_url: String,
    message: Option<String>,
    checked_at: String,
}

impl RuntimeState {
    fn with_worker<T>(
        &self,
        callback: impl FnOnce(&WorkerHandle) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.worker.lock().map_err(|err| err.to_string())?;
        let worker = guard.as_ref().ok_or_else(|| {
            "Worker is unavailable because startup checks failed. Review the startup error in the dashboard or logs.".to_string()
        })?;
        callback(worker)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPrinter {
    name: String,
    is_default: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetPreviewPayload {
    content: Option<String>,
    content_type: Option<String>,
    filename: Option<String>,
}

fn search_receiver_orders_request(
    client: &reqwest::blocking::Client,
    backend_url: &str,
    token: &str,
    machine_id: Option<&str>,
    query: &str,
) -> Result<reqwest::blocking::Response, String> {
    let mut request = client
        .get(format!("{backend_url}/api/receiver/orders/search"))
        .bearer_auth(token)
        .query(&[("query", query)]);
    if let Some(machine_id) = machine_id.filter(|value| !value.trim().is_empty()) {
        request = request.query(&[("machine_id", machine_id)]);
    }

    request
        .send()
        .map_err(|err| format!("Failed to search PX orders for \"{query}\" at {backend_url}: {err}"))
}

fn read_response_detail(response: reqwest::blocking::Response) -> String {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.contains("application/json") {
        if let Ok(payload) = response.json::<serde_json::Value>() {
            for key in ["detail", "error", "message"] {
                if let Some(value) = payload.get(key).and_then(|item| item.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }
        }
    } else if let Ok(body) = response.text() {
        let trimmed = body.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    format!("HTTP {}", status)
}

fn px_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .build()
        .map_err(|err| format!("Failed to build PX client: {err}"))
}

#[tauri::command]
fn fetch_receiver_routes_native(
    backend_url: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let backend_url = backend_url.trim().trim_end_matches('/').to_string();
    let token = token.trim().to_string();
    if backend_url.is_empty() || token.is_empty() {
        return Ok(serde_json::json!({
            "routes": [],
            "stores": [],
            "manualOverrideAllowed": true,
        }));
    }

    let response = px_client()?
        .get(format!("{backend_url}/api/receiver/routes"))
        .bearer_auth(token)
        .send()
        .map_err(|err| format!("Failed to load PX routes from {backend_url}: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = read_response_detail(response);
        return Err(format!("Failed to load PX routes ({status}): {detail}"));
    }

    response
        .json::<serde_json::Value>()
        .map_err(|err| format!("Failed to decode PX routes response: {err}"))
}

#[tauri::command]
fn search_receiver_orders_native(
    backend_url: String,
    token: String,
    machine_id: String,
    query: String,
) -> Result<serde_json::Value, String> {
    let backend_url = backend_url.trim().trim_end_matches('/').to_string();
    let token = token.trim().to_string();
    let machine_id = machine_id.trim().to_string();
    let query = query.trim().to_string();
    if backend_url.is_empty() || token.is_empty() || query.is_empty() {
        return Ok(serde_json::json!([]));
    }

    let client = px_client()?;
    let mut response =
        search_receiver_orders_request(&client, &backend_url, &token, Some(machine_id.as_str()), &query)?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        response = search_receiver_orders_request(&client, &backend_url, &token, None, &query)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(serde_json::json!([]));
        }
    }

    if !response.status().is_success() {
        let status = response.status();
        let detail = read_response_detail(response);
        return Err(format!("Failed to search PX orders ({status}): {detail}"));
    }

    response
        .json::<serde_json::Value>()
        .map_err(|err| format!("Failed to decode PX search response: {err}"))
}

#[tauri::command]
fn get_worker_snapshot(state: State<'_, RuntimeState>) -> Result<WorkerSnapshot, String> {
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn update_worker_settings(
    state: State<'_, RuntimeState>,
    settings: WorkerSettings,
) -> Result<WorkerSnapshot, String> {
    let mut store = state.store.lock().map_err(|err| err.to_string())?;
    store.snapshot.settings = settings.clone();
    store.persist_settings().map_err(|err| err.to_string())?;
    drop(store);

    let _ = state.with_worker(|worker| {
        worker
            .update_settings(settings.clone())
            .map_err(|err| err.to_string())
    });

    let mut store = state.store.lock().map_err(|err| err.to_string())?;
    if state
        .worker
        .lock()
        .map_err(|err| err.to_string())?
        .is_none()
    {
        store.snapshot.current_activity =
            "Settings saved. Restart worker to apply them.".to_string();
    }
    Ok(store.snapshot.clone())
}

#[tauri::command]
fn pause_worker_polling(state: State<'_, RuntimeState>) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.pause().map_err(|err| err.to_string()))?;
    let mut store = state.store.lock().map_err(|err| err.to_string())?;
    store.snapshot.polling_paused = true;
    store.snapshot.health = worker::HealthState::Paused;
    store.snapshot.current_activity = "Receiving orders, output paused".into();
    Ok(store.snapshot.clone())
}

#[tauri::command]
fn resume_worker_polling(state: State<'_, RuntimeState>) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.resume().map_err(|err| err.to_string()))?;
    let mut store = state.store.lock().map_err(|err| err.to_string())?;
    store.snapshot.polling_paused = false;
    store.snapshot.health = worker::HealthState::Healthy;
    store.snapshot.current_activity = "Receiving and dispatching output".into();
    Ok(store.snapshot.clone())
}

#[tauri::command]
fn poll_worker_now(state: State<'_, RuntimeState>) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.poll_now().map_err(|err| err.to_string()))?;
    let mut store = state.store.lock().map_err(|err| err.to_string())?;
    store.snapshot.current_activity = "Refreshing queue".into();
    if !store.snapshot.polling_paused {
        store.snapshot.health = worker::HealthState::Processing;
    }
    Ok(store.snapshot.clone())
}

#[tauri::command]
fn retry_worker_job(
    state: State<'_, RuntimeState>,
    job_id: String,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.retry_job(job_id).map_err(|err| err.to_string()))?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn recover_remote_job(
    state: State<'_, RuntimeState>,
    job: serde_json::Value,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.recover_job(job).map_err(|err| err.to_string()))?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn reprint_worker_job(
    state: State<'_, RuntimeState>,
    job_id: String,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.reprint_job(job_id).map_err(|err| err.to_string()))?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn print_worker_packing_slip(
    state: State<'_, RuntimeState>,
    job_id: String,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| {
        worker
            .print_packing_slip(job_id)
            .map_err(|err| err.to_string())
    })?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn print_worker_label(
    state: State<'_, RuntimeState>,
    job_id: String,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| worker.print_label(job_id).map_err(|err| err.to_string()))?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn force_complete_worker_job(
    state: State<'_, RuntimeState>,
    job_id: String,
) -> Result<WorkerSnapshot, String> {
    state.with_worker(|worker| {
        worker
            .force_complete_job(job_id)
            .map_err(|err| err.to_string())
    })?;
    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn restart_worker_runtime(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<WorkerSnapshot, String> {
    {
        let mut worker_slot = state.worker.lock().map_err(|err| err.to_string())?;
        *worker_slot = None;
    }

    let spawned = WorkerHandle::spawn(app, state.store.clone()).map_err(|err| err.to_string());
    match spawned {
        Ok(worker) => {
            let mut worker_slot = state.worker.lock().map_err(|err| err.to_string())?;
            *worker_slot = Some(worker);
        }
        Err(message) => {
            let mut store = state.store.lock().map_err(|err| err.to_string())?;
            store.snapshot.health = HealthState::Error;
            store.snapshot.current_activity = message.clone();
            store.snapshot.logs.insert(
                0,
                LogRecord {
                    id: Uuid::new_v4().to_string(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    level: LogLevel::Error,
                    message: message.clone(),
                    scope: "startup".into(),
                },
            );
            store.snapshot.logs.truncate(250);
            return Ok(store.snapshot.clone());
        }
    }

    state
        .store
        .lock()
        .map_err(|err| err.to_string())
        .map(|store| store.snapshot.clone())
}

#[tauri::command]
fn relaunch_application(app: AppHandle) -> Result<(), String> {
    app.restart();
}

fn open_url_in_os_impl(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|err| format!("Failed to open URL: {err}"))?;

    if !status.success() {
        return Err(format!("Failed to open URL: {url}"));
    }

    Ok(())
}

fn latest_installer_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://github.com/PhotoZone/PX-Receiver/releases/latest/download/PX-Receiver-Windows-x64-setup.exe"
    } else if cfg!(target_os = "macos") {
        "https://github.com/PhotoZone/PX-Receiver/releases/latest/download/PX-Receiver-macOS.dmg"
    } else {
        "https://github.com/PhotoZone/PX-Receiver/releases"
    }
}

#[tauri::command]
fn download_latest_app_build() -> Result<(), String> {
    open_url_in_os_impl(latest_installer_url())
}

fn parse_semver_triplet(value: &str) -> Option<(u64, u64, u64)> {
    let trimmed = value.trim().trim_start_matches('v');
    let core = trimmed.split(['-', '+']).next()?.trim();
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn extract_version_from_release(tag_name: &str, release_name: &str) -> Option<String> {
    if parse_semver_triplet(tag_name).is_some() {
        return Some(tag_name.trim().trim_start_matches('v').to_string());
    }

    for token in release_name.split_whitespace() {
        if parse_semver_triplet(token).is_some() {
            return Some(token.trim().trim_start_matches('v').to_string());
        }
    }

    None
}

#[tauri::command]
fn check_for_app_update(app: AppHandle) -> Result<AppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let download_url = latest_installer_url().to_string();
    let release_url = "https://github.com/PhotoZone/PX-Receiver/releases".to_string();

    let response = px_client()?
        .get("https://api.github.com/repos/PhotoZone/PX-Receiver/releases/latest")
        .header(reqwest::header::USER_AGENT, "PX-Receiver")
        .send()
        .map_err(|err| format!("Failed to check for updates: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = read_response_detail(response);
        return Err(format!("Failed to check for updates ({status}): {detail}"));
    }

    let payload = response
        .json::<serde_json::Value>()
        .map_err(|err| format!("Failed to decode latest release metadata: {err}"))?;
    let tag_name = payload
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let release_name = payload
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let latest_version = extract_version_from_release(tag_name, release_name);

    let (is_update_available, message) = match (
        parse_semver_triplet(&current_version),
        latest_version.as_deref().and_then(parse_semver_triplet),
    ) {
        (Some(current), Some(latest)) => {
            if latest > current {
                (
                    true,
                    Some(format!(
                        "Version {} is available. You have {} installed.",
                        latest_version.clone().unwrap_or_default(),
                        current_version
                    )),
                )
            } else {
                (
                    false,
                    Some(format!("Latest version already installed ({current_version}).")),
                )
            }
        }
        _ => (
            false,
            Some("Unable to compare the installed version against the latest release yet.".to_string()),
        ),
    };

    Ok(AppUpdateStatus {
        current_version,
        latest_version,
        is_update_available,
        download_url,
        release_url,
        message,
        checked_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
fn open_folder_in_os(path: String) -> Result<(), String> {
    let resolved = expand_user_path(&path);
    if !resolved.exists() {
        return Err(format!("Folder does not exist: {}", resolved.display()));
    }

    let status = if cfg!(target_os = "windows") {
        Command::new("explorer").arg(&resolved).status()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&resolved).status()
    } else {
        Command::new("xdg-open").arg(&resolved).status()
    }
    .map_err(|err| format!("Failed to open folder: {err}"))?;

    if !status.success() {
        return Err(format!("Failed to open folder: {}", resolved.display()));
    }

    Ok(())
}

#[tauri::command]
fn pick_folder(initial_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = FileDialog::new();
    if let Some(path) = initial_path.filter(|value| !value.trim().is_empty()) {
        dialog = dialog.set_directory(path);
    }

    Ok(dialog.pick_folder().map(|path| path.display().to_string()))
}

#[tauri::command]
fn get_installed_printers() -> Result<Vec<InstalledPrinter>, String> {
    list_installed_printers()
}

#[tauri::command]
fn save_scanner_driver(app: AppHandle) -> Result<Option<String>, String> {
    let resource_path = app
        .path()
        .resolve("CH34x_Install_Windows_v3_4.EXE", BaseDirectory::Resource)
        .map_err(|err| format!("Failed to resolve bundled driver: {err}"))?;

    let default_destination = app
        .path()
        .download_dir()
        .map(|dir| dir.join("CH34x_Install_Windows_v3_4.EXE"))
        .unwrap_or_else(|_| std::path::PathBuf::from("CH34x_Install_Windows_v3_4.EXE"));

    let destination = FileDialog::new()
        .set_file_name("CH34x_Install_Windows_v3_4.EXE")
        .set_directory(
            default_destination
                .parent()
                .unwrap_or_else(|| std::path::Path::new(".")),
        )
        .save_file();

    let Some(destination) = destination else {
        return Ok(None);
    };

    fs::copy(&resource_path, &destination)
        .map_err(|err| format!("Failed to save bundled driver: {err}"))?;

    Ok(Some(destination.display().to_string()))
}

#[tauri::command]
fn fetch_asset_preview(
    app: AppHandle,
    url: String,
    token: Option<String>,
) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Failed to resolve cache directory: {err}"))?
        .join("asset-previews");
    fs::create_dir_all(&cache_dir)
        .map_err(|err| format!("Failed to create preview cache directory: {err}"))?;
    prune_preview_cache(&cache_dir);

    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|err| format!("Failed to build preview client: {err}"))?;

    let mut request = client.get(&url);
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .map_err(|err| format!("Failed to fetch asset preview: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch asset preview ({})",
            response.status()
        ));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.contains("application/json") {
        let payload: AssetPreviewPayload = response
            .json()
            .map_err(|err| format!("Failed to decode preview payload: {err}"))?;
        let content = payload
            .content
            .ok_or_else(|| "Asset preview payload did not contain content".to_string())?;
        let mime = payload
            .content_type
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|err| format!("Failed to decode preview bytes: {err}"))?;
        let cache_path = preview_cache_path(&cache_dir, &url, payload.filename.as_deref(), &mime);
        fs::write(&cache_path, bytes)
            .map_err(|err| format!("Failed to write preview cache file: {err}"))?;
        return Ok(cache_path.display().to_string());
    }

    let mime = if content_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        content_type
    };
    let bytes = response
        .bytes()
        .map_err(|err| format!("Failed to read asset preview bytes: {err}"))?;
    let cache_path = preview_cache_path(&cache_dir, &url, None, &mime);
    fs::write(&cache_path, &bytes)
        .map_err(|err| format!("Failed to write preview cache file: {err}"))?;
    Ok(cache_path.display().to_string())
}

#[tauri::command]
fn read_local_asset_preview(path: String) -> Result<String, String> {
    let file_path = std::path::PathBuf::from(&path);
    let bytes =
        fs::read(&file_path).map_err(|err| format!("Failed to read local asset preview: {err}"))?;
    let mime = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .and_then(|ext| match ext.as_str() {
            "jpg" | "jpeg" => Some("image/jpeg"),
            "png" => Some("image/png"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            "bmp" => Some("image/bmp"),
            "tif" | "tiff" => Some("image/tiff"),
            "svg" => Some("image/svg+xml"),
            _ => None,
        })
        .unwrap_or("application/octet-stream");
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn preview_cache_path(
    cache_dir: &std::path::Path,
    url: &str,
    filename: Option<&str>,
    mime: &str,
) -> std::path::PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let key = format!("{:x}", hasher.finish());
    let extension = filename
        .and_then(|name| {
            std::path::Path::new(name)
                .extension()
                .and_then(|ext| ext.to_str())
        })
        .or_else(|| preview_extension_for_mime(mime))
        .unwrap_or("bin");
    cache_dir.join(format!("{key}.{extension}"))
}

fn preview_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

fn prune_preview_cache(cache_dir: &std::path::Path) {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(60 * 60 * 24 * 7))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = fs::remove_file(path);
        }
    }
}

fn list_installed_printers() -> Result<Vec<InstalledPrinter>, String> {
    if cfg!(target_os = "windows") {
        return list_windows_printers();
    }

    list_cups_printers()
}

fn list_cups_printers() -> Result<Vec<InstalledPrinter>, String> {
    let output = Command::new("lpstat")
        .args(["-p", "-d"])
        .output()
        .map_err(|err| format!("Failed to query printers with lpstat: {err}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut names: Vec<String> = Vec::new();
    let mut default_name: Option<String> = None;

    for line in stdout.lines() {
        if let Some(name) = line
            .strip_prefix("printer ")
            .and_then(|value| value.split_whitespace().next())
        {
            let printer = name.trim().to_string();
            if !printer.is_empty() && !names.contains(&printer) {
                names.push(printer);
            }
            continue;
        }

        if let Some(name) = line.strip_prefix("system default destination: ") {
            let printer = name.trim().to_string();
            if !printer.is_empty() {
                default_name = Some(printer);
            }
        }
    }

    Ok(names
        .into_iter()
        .map(|name| InstalledPrinter {
            is_default: default_name.as_ref() == Some(&name),
            name,
        })
        .collect())
}

fn list_windows_printers() -> Result<Vec<InstalledPrinter>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Printer | Select-Object Name,Default | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|err| format!("Failed to query printers with PowerShell: {err}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(Vec::new());
    }

    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|err| err.to_string())?;
    let items = match parsed {
        serde_json::Value::Array(items) => items,
        item => vec![item],
    };

    Ok(items
        .into_iter()
        .filter_map(|item| {
            let name = item.get("Name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(InstalledPrinter {
                is_default: item
                    .get("Default")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                name,
            })
        })
        .collect())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItemBuilder::with_id("open", "Open").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "Hide").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open_item, &hide_item, &quit_item])
        .build()?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;

    Ok(())
}

fn launch_runtime(app: &AppHandle) -> Result<RuntimeState, String> {
    let store = Arc::new(Mutex::new(
        AppStateStore::new(app).map_err(|err| err.to_string())?,
    ));
    let worker = match WorkerHandle::spawn(app.clone(), store.clone()) {
        Ok(worker) => Some(worker),
        Err(err) => {
            let message = err.to_string();
            let mut store_lock = store.lock().map_err(|lock_err| lock_err.to_string())?;
            store_lock.snapshot.health = HealthState::Error;
            store_lock.snapshot.current_activity = message.clone();
            store_lock.snapshot.logs.insert(
                0,
                LogRecord {
                    id: Uuid::new_v4().to_string(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    level: LogLevel::Error,
                    message: message.clone(),
                    scope: "startup".into(),
                },
            );
            store_lock.snapshot.logs.truncate(250);
            let _ = store_lock.persist_settings();
            None
        }
    };
    Ok(RuntimeState {
        store,
        worker: Mutex::new(worker),
    })
}

fn expand_user_path(value: &str) -> std::path::PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home).join(stripped);
        }
    }

    std::path::PathBuf::from(value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            build_tray(app.handle())?;
            let runtime = launch_runtime(app.handle())
                .map_err(|err| -> Box<dyn std::error::Error> { err.into() })?;
            app.manage(runtime);

            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.emit(
                            "worker://event",
                            worker::WorkerEvent::health_only("Receiver hidden to tray".into()),
                        );
                        let _ = handle
                            .get_webview_window("main")
                            .map(|window| window.hide());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_worker_snapshot,
            update_worker_settings,
            pause_worker_polling,
            resume_worker_polling,
            poll_worker_now,
            retry_worker_job,
            recover_remote_job,
            reprint_worker_job,
            print_worker_packing_slip,
            print_worker_label,
            force_complete_worker_job,
            restart_worker_runtime,
            relaunch_application,
            check_for_app_update,
            download_latest_app_build,
            open_folder_in_os,
            pick_folder,
            get_installed_printers,
            save_scanner_driver,
            fetch_receiver_routes_native,
            search_receiver_orders_native,
            fetch_asset_preview,
            read_local_asset_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
