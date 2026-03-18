use std::env;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("configuration directory unavailable")]
    MissingConfigDirectory,
    #[error("worker stdin unavailable")]
    MissingStdin,
    #[error("worker startup check failed: {0}")]
    StartupCheck(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    Healthy,
    Paused,
    Error,
    Offline,
    Processing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Pending,
    Downloading,
    Downloaded,
    Processing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LargeFormatJobStatus {
    Waiting,
    NeedsReview,
    Batched,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LargeFormatBatchStatus {
    Pending,
    Ready,
    Approved,
    Printing,
    Sent,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Image,
    Pdf,
    Control,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSettings {
    pub backend_url: String,
    pub machine_id: String,
    pub machine_name: String,
    pub api_token: String,
    #[serde(default)]
    pub shipstation_api_key: String,
    #[serde(default)]
    pub slack_webhook_url: String,
    #[serde(default = "default_scanner_mode")]
    pub scanner_mode: String,
    #[serde(default)]
    pub machine_auth_token: String,
    pub polling_interval_seconds: u64,
    pub download_directory: String,
    pub hot_folder_path: String,
    #[serde(default)]
    pub photo_print_hot_folder_path: String,
    #[serde(default)]
    pub photo_gift_hot_folder_path: String,
    #[serde(default)]
    pub large_format_hot_folder_path: String,
    #[serde(default)]
    pub large_format_photozone_input_folder_path: String,
    #[serde(default)]
    pub large_format_postsnap_input_folder_path: String,
    #[serde(default)]
    pub large_format_output_folder_path: String,
    #[serde(default)]
    pub large_format_batching_interval_minutes: u64,
    #[serde(default)]
    pub large_format_roll_width_in: f64,
    #[serde(default)]
    pub large_format_gap_mm: f64,
    #[serde(default)]
    pub large_format_leader_mm: f64,
    #[serde(default)]
    pub large_format_trailer_mm: f64,
    #[serde(default)]
    pub large_format_left_margin_mm: f64,
    #[serde(default)]
    pub large_format_max_batch_length_mm: f64,
    #[serde(default)]
    pub large_format_auto_send: bool,
    #[serde(default)]
    pub large_format_direct_print: bool,
    #[serde(default)]
    pub large_format_printer_name: String,
    #[serde(default)]
    pub large_format_auto_approve_enabled: bool,
    #[serde(default)]
    pub large_format_auto_approve_max_waste_percent: f64,
    #[serde(default)]
    pub large_format_auto_border_if_light_edge: bool,
    #[serde(default)]
    pub large_format_edge_border_mm: f64,
    #[serde(default)]
    pub large_format_print_filename_captions: bool,
    #[serde(default)]
    pub large_format_filename_caption_height_mm: f64,
    #[serde(default)]
    pub large_format_filename_caption_font_size_pt: f64,
    #[serde(default)]
    pub packing_slip_printer_name: String,
    #[serde(default)]
    pub shipping_label_printer_name: String,
    pub use_mock_backend: bool,
}

impl Default for WorkerSettings {
    fn default() -> Self {
        Self {
            backend_url: "https://px.photozone.co.uk".into(),
            machine_id: "machine-demo-001".into(),
            machine_name: "PX Receiver 01".into(),
            api_token: String::new(),
            shipstation_api_key: String::new(),
            slack_webhook_url: String::new(),
            scanner_mode: default_scanner_mode(),
            machine_auth_token: String::new(),
            polling_interval_seconds: 20,
            download_directory: "~/Downloads/px-orders".into(),
            hot_folder_path: "~/HotFolders/px".into(),
            photo_print_hot_folder_path: "//PICSERVER/C8Spool".into(),
            photo_gift_hot_folder_path: "~/HotFolders/Sublimation".into(),
            large_format_hot_folder_path: "~/HotFolders/Large Format".into(),
            large_format_photozone_input_folder_path: "~/HotFolders/Photo Zone Large Format Hot Folder".into(),
            large_format_postsnap_input_folder_path: "~/HotFolders/Postsnap Large Format Hot Folder".into(),
            large_format_output_folder_path: "~/HotFolders/Large Format/Output".into(),
            large_format_batching_interval_minutes: 10,
            large_format_roll_width_in: 36.0,
            large_format_gap_mm: 8.0,
            large_format_leader_mm: 50.0,
            large_format_trailer_mm: 50.0,
            large_format_left_margin_mm: 5.0,
            large_format_max_batch_length_mm: 1000.0,
            large_format_auto_send: false,
            large_format_direct_print: false,
            large_format_printer_name: String::new(),
            large_format_auto_approve_enabled: true,
            large_format_auto_approve_max_waste_percent: 20.0,
            large_format_auto_border_if_light_edge: true,
            large_format_edge_border_mm: 1.0,
            large_format_print_filename_captions: true,
            large_format_filename_caption_height_mm: 6.0,
            large_format_filename_caption_font_size_pt: 9.0,
            packing_slip_printer_name: String::new(),
            shipping_label_printer_name: String::new(),
            use_mock_backend: true,
        }
    }
}

fn default_scanner_mode() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    pub id: String,
    pub kind: AssetKind,
    pub filename: String,
    pub download_url: Option<String>,
    pub content_type: Option<String>,
    pub local_path: Option<String>,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintInstructions {
    pub auto_print_pdf: bool,
    pub printer_name: Option<String>,
    pub copies: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobItemRecord {
    pub name: String,
    pub quantity: u32,
    pub finish: Option<String>,
    pub border: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecord {
    pub id: String,
    pub code: String,
    pub source: String,
    pub timestamp: String,
    pub status: String,
    pub message: Option<String>,
    pub job_id: Option<String>,
    pub order_id: Option<String>,
    pub can_reprint_label: bool,
    pub shipping_label_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerState {
    pub status: String,
    pub port: Option<String>,
    pub last_scan_at: Option<String>,
    pub last_code: Option<String>,
    pub recent_scans: Vec<ScanRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub order_id: String,
    pub source: Option<String>,
    pub store_id: Option<String>,
    pub target_machine_id: Option<String>,
    pub target_location: Option<String>,
    pub ordered_at: Option<String>,
    pub product_name: String,
    pub printer: Option<String>,
    pub customer_name: Option<String>,
    pub customer_email: Option<String>,
    pub customer_phone: Option<String>,
    pub delivery_method: Option<String>,
    pub shipment_id: Option<String>,
    pub shipping_label_path: Option<String>,
    pub shipping_address_line1: Option<String>,
    pub shipping_address_line2: Option<String>,
    pub shipping_city: Option<String>,
    pub shipping_postcode: Option<String>,
    pub shipping_country: Option<String>,
    pub items: Vec<JobItemRecord>,
    pub assets: Vec<AssetRecord>,
    pub status: JobStatus,
    pub assigned_machine: String,
    pub local_path: Option<String>,
    pub local_paths: std::collections::HashMap<String, String>,
    pub print_instructions: Option<PrintInstructions>,
    pub last_error: Option<String>,
    pub updated_at: String,
    pub created_at: String,
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub message: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFormatPlacement {
    pub job_id: String,
    pub filename: String,
    pub x_mm: f64,
    pub y_mm: f64,
    pub placed_width_mm: f64,
    pub placed_height_mm: f64,
    pub rotated: bool,
    pub sort_order: u32,
    pub add_black_border: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFormatJob {
    pub id: String,
    pub filename: String,
    pub original_path: String,
    pub width_in: Option<f64>,
    pub height_in: Option<f64>,
    pub media_type: String,
    pub quantity: u32,
    pub source: String,
    pub status: LargeFormatJobStatus,
    pub created_at: String,
    pub updated_at: String,
    pub parse_source: Option<String>,
    pub notes: Option<String>,
    pub needs_border: bool,
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFormatBatch {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: LargeFormatBatchStatus,
    pub media_type: String,
    pub roll_width_in: f64,
    pub gap_mm: f64,
    pub leader_mm: f64,
    pub trailer_mm: f64,
    pub caption_height_mm: f64,
    pub used_length_mm: f64,
    pub waste_percent: f64,
    pub output_pdf_path: Option<String>,
    pub hot_folder_sent_at: Option<String>,
    pub notes: Option<String>,
    pub placements: Vec<LargeFormatPlacement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFormatActivity {
    pub id: String,
    pub timestamp: String,
    pub event: String,
    pub message: String,
    pub level: LogLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFormatState {
    pub jobs: Vec<LargeFormatJob>,
    pub batches: Vec<LargeFormatBatch>,
    pub activity: Vec<LargeFormatActivity>,
    pub active_batch_id: Option<String>,
    pub last_scan_at: Option<String>,
    pub last_processed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSnapshot {
    pub health: HealthState,
    pub polling_paused: bool,
    pub queue_count: usize,
    pub last_sync_at: Option<String>,
    pub active_job_id: Option<String>,
    pub current_activity: String,
    pub settings: WorkerSettings,
    pub scanner: ScannerState,
    pub jobs: Vec<JobRecord>,
    pub logs: Vec<LogRecord>,
    pub large_format: LargeFormatState,
}

impl WorkerSnapshot {
    fn new(settings: WorkerSettings) -> Self {
        Self {
            health: HealthState::Offline,
            polling_paused: false,
            queue_count: 0,
            last_sync_at: None,
            active_job_id: None,
            current_activity: "Starting worker".into(),
            settings,
            scanner: ScannerState {
                status: "disabled".into(),
                port: None,
                last_scan_at: None,
                last_code: None,
                recent_scans: Vec::new(),
            },
            jobs: Vec::new(),
            logs: Vec::new(),
            large_format: LargeFormatState {
                jobs: Vec::new(),
                batches: Vec::new(),
                activity: Vec::new(),
                active_batch_id: None,
                last_scan_at: None,
                last_processed_at: None,
            },
        }
    }
}

pub struct AppStateStore {
    pub snapshot: WorkerSnapshot,
    config_path: PathBuf,
}

impl AppStateStore {
    pub fn new(app: &AppHandle) -> Result<Self, WorkerError> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|_| WorkerError::MissingConfigDirectory)?;
        fs::create_dir_all(&config_dir)?;

        let config_path = config_dir.join("receiver-config.json");
        let settings = if config_path.exists() {
            serde_json::from_str(&fs::read_to_string(&config_path)?)?
        } else {
            let settings = WorkerSettings::default();
            fs::write(&config_path, serde_json::to_string_pretty(&settings)?)?;
            settings
        };

        Ok(Self {
            snapshot: WorkerSnapshot::new(settings),
            config_path,
        })
    }

    pub fn persist_settings(&self) -> Result<(), WorkerError> {
        fs::write(
            &self.config_path,
            serde_json::to_string_pretty(&self.snapshot.settings)?,
        )?;
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum WorkerCommand {
    Pause,
    Resume,
    PollNow,
    ScanLargeFormatNow,
    ProcessLargeFormatNow,
    CreateManualLargeFormatBatch { job_id: String },
    ApproveLargeFormatBatch { batch_id: String },
    SendLargeFormatBatch { batch_id: String },
    RegenerateLargeFormatBatch { batch_id: String },
    RemoveLargeFormatBatch { batch_id: String },
    DeleteLargeFormatJob { job_id: String },
    RetryJob { job_id: String },
    RemoveLocalJob { job_id: String },
    RecoverJob { job: serde_json::Value },
    ReprintJob { job_id: String },
    PrintPackingSlip { job_id: String },
    PrintLabel { job_id: String },
    ReprintScanLabel { scan_id: String },
    ForceCompleteJob { job_id: String },
    UpdateSettings { settings: WorkerSettings },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerEvent {
    Snapshot { payload: WorkerSnapshot },
    Log { payload: LogRecord },
    Job { payload: JobRecord },
    Scan { payload: ScanRecord },
    Scanner { payload: ScannerState },
    Health { payload: HealthPayload },
}

impl WorkerEvent {
    pub fn health_only(activity: String) -> Self {
        Self::Health {
            payload: HealthPayload {
                health: HealthState::Healthy,
                polling_paused: false,
                active_job_id: None,
                current_activity: activity,
                last_sync_at: None,
                queue_count: 0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthPayload {
    pub health: HealthState,
    pub polling_paused: bool,
    pub active_job_id: Option<String>,
    pub current_activity: String,
    pub last_sync_at: Option<String>,
    pub queue_count: usize,
}

pub struct WorkerHandle {
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    _child: Arc<Mutex<Child>>,
}

impl WorkerHandle {
    pub fn spawn(app: AppHandle, store: Arc<Mutex<AppStateStore>>) -> Result<Self, WorkerError> {
        let (config_path, settings) = {
            let store = store
                .lock()
                .map_err(|_| WorkerError::MissingConfigDirectory)?;
            (store.config_path.clone(), store.snapshot.settings.clone())
        };
        run_startup_self_check(&app, &config_path, &settings)?;
        let mut worker_command = worker_launch_command(&app, &config_path);
        let mut child = worker_command.spawn()?;
        let stdin = child.stdin.take().ok_or(WorkerError::MissingStdin)?;
        let stdout = child.stdout.take().ok_or(WorkerError::MissingStdin)?;
        let stderr = child.stderr.take().ok_or(WorkerError::MissingStdin)?;
        let stdin = Arc::new(Mutex::new(BufWriter::new(stdin)));
        let child = Arc::new(Mutex::new(child));

        read_stream(app.clone(), store.clone(), stdout, false);
        read_stream(app, store, stderr, true);

        Ok(Self {
            stdin,
            _child: child,
        })
    }

    fn send(&self, command: WorkerCommand) -> Result<(), WorkerError> {
        let mut stdin = self.stdin.lock().map_err(|_| WorkerError::MissingStdin)?;
        let payload = serde_json::to_string(&command)?;
        stdin.write_all(payload.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), WorkerError> {
        self.send(WorkerCommand::Pause)
    }

    pub fn resume(&self) -> Result<(), WorkerError> {
        self.send(WorkerCommand::Resume)
    }

    pub fn poll_now(&self) -> Result<(), WorkerError> {
        self.send(WorkerCommand::PollNow)
    }

    pub fn retry_job(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::RetryJob { job_id })
    }

    pub fn remove_local_job(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::RemoveLocalJob { job_id })
    }

    pub fn scan_large_format_now(&self) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ScanLargeFormatNow)
    }

    pub fn process_large_format_now(&self) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ProcessLargeFormatNow)
    }

    pub fn create_manual_large_format_batch(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::CreateManualLargeFormatBatch { job_id })
    }

    pub fn approve_large_format_batch(&self, batch_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ApproveLargeFormatBatch { batch_id })
    }

    pub fn send_large_format_batch(&self, batch_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::SendLargeFormatBatch { batch_id })
    }

    pub fn regenerate_large_format_batch(&self, batch_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::RegenerateLargeFormatBatch { batch_id })
    }

    pub fn remove_large_format_batch(&self, batch_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::RemoveLargeFormatBatch { batch_id })
    }

    pub fn delete_large_format_job(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::DeleteLargeFormatJob { job_id })
    }

    pub fn recover_job(&self, job: serde_json::Value) -> Result<(), WorkerError> {
        self.send(WorkerCommand::RecoverJob { job })
    }

    pub fn reprint_job(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ReprintJob { job_id })
    }

    pub fn print_packing_slip(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::PrintPackingSlip { job_id })
    }

    pub fn print_label(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::PrintLabel { job_id })
    }

    pub fn reprint_scan_label(&self, scan_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ReprintScanLabel { scan_id })
    }

    pub fn force_complete_job(&self, job_id: String) -> Result<(), WorkerError> {
        self.send(WorkerCommand::ForceCompleteJob { job_id })
    }

    pub fn update_settings(&self, settings: WorkerSettings) -> Result<(), WorkerError> {
        self.send(WorkerCommand::UpdateSettings {
            settings: settings.clone(),
        })
    }
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        let _ = self.send(WorkerCommand::Shutdown);
    }
}

fn read_stream<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    store: Arc<Mutex<AppStateStore>>,
    stream: R,
    is_stderr: bool,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            if is_stderr {
                let event = WorkerEvent::Log {
                    payload: LogRecord {
                        id: Uuid::new_v4().to_string(),
                        timestamp: chrono_like_timestamp(),
                        level: LogLevel::Error,
                        message: line.clone(),
                        scope: "worker-stderr".into(),
                    },
                };
                apply_event(&app, &store, event);
                continue;
            }

            match serde_json::from_str::<WorkerEvent>(&line) {
                Ok(event) => apply_event(&app, &store, event),
                Err(_) => {
                    let event = WorkerEvent::Log {
                        payload: LogRecord {
                            id: Uuid::new_v4().to_string(),
                            timestamp: chrono_like_timestamp(),
                            level: LogLevel::Warning,
                            message: format!("Unparsed worker output: {line}"),
                            scope: "bridge".into(),
                        },
                    };
                    apply_event(&app, &store, event);
                }
            }
        }
    });
}

fn apply_event(app: &AppHandle, store: &Arc<Mutex<AppStateStore>>, event: WorkerEvent) {
    if let Ok(mut store) = store.lock() {
        match &event {
            WorkerEvent::Snapshot { payload } => store.snapshot = payload.clone(),
            WorkerEvent::Log { payload } => {
                store.snapshot.logs.insert(0, payload.clone());
                store.snapshot.logs.truncate(250);
            }
            WorkerEvent::Job { payload } => {
                store.snapshot.jobs.retain(|job| job.id != payload.id);
                store.snapshot.jobs.insert(0, payload.clone());
                store.snapshot.jobs.truncate(150);
                store.snapshot.queue_count = store
                    .snapshot
                    .jobs
                    .iter()
                    .filter(|job| {
                        matches!(
                            job.status,
                            JobStatus::Pending
                                | JobStatus::Downloading
                                | JobStatus::Downloaded
                                | JobStatus::Processing
                        )
                    })
                    .count();
            }
            WorkerEvent::Scan { payload } => {
                store.snapshot.scanner.last_scan_at = Some(payload.timestamp.clone());
                store.snapshot.scanner.last_code = Some(payload.code.clone());
                store
                    .snapshot
                    .scanner
                    .recent_scans
                    .retain(|scan| scan.id != payload.id);
                store
                    .snapshot
                    .scanner
                    .recent_scans
                    .insert(0, payload.clone());
                store.snapshot.scanner.recent_scans.truncate(50);
            }
            WorkerEvent::Scanner { payload } => {
                store.snapshot.scanner = payload.clone();
            }
            WorkerEvent::Health { payload } => {
                store.snapshot.health = payload.health.clone();
                store.snapshot.polling_paused = payload.polling_paused;
                store.snapshot.active_job_id = payload.active_job_id.clone();
                store.snapshot.current_activity = payload.current_activity.clone();
                store.snapshot.last_sync_at = payload.last_sync_at.clone();
                store.snapshot.queue_count = payload.queue_count;
            }
        }

        if let WorkerEvent::Snapshot { .. } | WorkerEvent::Health { .. } = &event {
            let _ = store.persist_settings();
        }
    }

    let _ = app.emit("worker://event", &event);
}

fn worker_launch_command(app: &AppHandle, config_path: &Path) -> Command {
    let mut command = if cfg!(debug_assertions) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let root = repo_root.join("worker");
        let python = if cfg!(target_os = "windows") {
            root.join(".venv").join("Scripts").join("python.exe")
        } else {
            root.join(".venv").join("bin").join("python3")
        };
        let mut command = Command::new(python);
        command
            .arg("-m")
            .arg("px_receiver")
            .arg("--config")
            .arg(config_path)
            .current_dir(root);
        command
    } else {
        let binary = bundled_worker_binary_candidates(app)
            .into_iter()
            .find(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("px-worker"));
        let mut command = Command::new(binary);
        command.arg("--config").arg(config_path);
        command
    };

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn worker_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("worker")
}

fn bundled_worker_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "px-worker-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "px-worker-aarch64-apple-darwin"
        } else {
            "px-worker-x86_64-apple-darwin"
        }
    } else {
        "px-worker-x86_64-unknown-linux-gnu"
    }
}

fn bundled_worker_binary_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let candidate_names: Vec<&str> = if cfg!(target_os = "windows") {
        vec!["px-worker.exe", "px-worker", bundled_worker_binary_name()]
    } else {
        vec!["px-worker", bundled_worker_binary_name()]
    };

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            for name in &candidate_names {
                candidates.push(parent.join(name));
            }
        }
    }

    let sidecar_root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for name in &candidate_names {
        candidates.push(sidecar_root.join(name));
    }
    candidates
}

fn debug_worker_python() -> PathBuf {
    let root = worker_root();
    if cfg!(target_os = "windows") {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python3")
    }
}

fn run_startup_self_check(
    app: &AppHandle,
    config_path: &Path,
    settings: &WorkerSettings,
) -> Result<(), WorkerError> {
    let mut failures: Vec<String> = Vec::new();

    if cfg!(debug_assertions) {
        let root = worker_root();
        let python = debug_worker_python();
        if !python.exists() {
            failures.push(format!(
                "Missing Python venv runtime at {}. Create the worker virtualenv before launching the app.",
                python.display()
            ));
        } else if let Err(message) = run_python_dependency_check(&python, &root) {
            failures.push(message);
        }

        failures.extend(check_node_dependencies(&root));
    } else {
        let binary = bundled_worker_binary_candidates(app)
            .into_iter()
            .find(|path| path.exists());
        if binary.is_none() {
            let expected = bundled_worker_binary_candidates(app)
                .into_iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" or ");
            failures.push(format!(
                "Missing bundled worker binary at {expected}"
            ));
        }
    }

    failures.extend(check_printer_configuration(settings));
    failures.extend(check_hot_folder_availability(settings));

    let _ = config_path;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(WorkerError::StartupCheck(failures.join(" | ")))
    }
}

fn run_python_dependency_check(python: &Path, root: &Path) -> Result<(), String> {
    let output = Command::new(python)
        .arg("-c")
        .arg(
            "import importlib\nmodules=['px_receiver','PIL','serial','reportlab']\nmissing=[]\nfor name in modules:\n    try:\n        importlib.import_module(name)\n    except Exception as exc:\n        missing.append(f'{name}: {exc}')\nif missing:\n    raise SystemExit('Missing worker dependencies: ' + '; '.join(missing))\nprint('worker-self-check:ok')",
        )
        .current_dir(root)
        .output()
        .map_err(|err| format!("Failed to run Python dependency check: {err}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(if detail.is_empty() {
        "Worker dependency check failed with no diagnostic output".into()
    } else {
        detail
    })
}

fn check_node_dependencies(worker_root: &Path) -> Vec<String> {
    let repo_root = worker_root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let node_modules = repo_root.join("node_modules");
    let required = [
        "next/package.json",
        "react/package.json",
        "react-dom/package.json",
        "@tauri-apps/api/package.json",
    ];

    let missing: Vec<String> = required
        .iter()
        .filter_map(|entry| {
            let path = node_modules.join(entry);
            if path.exists() {
                None
            } else {
                Some(entry.trim_end_matches("/package.json").to_string())
            }
        })
        .collect();

    if missing.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "Missing required Node dependencies in {}: {}. Run npm install.",
            node_modules.display(),
            missing.join(", ")
        )]
    }
}

fn check_printer_configuration(settings: &WorkerSettings) -> Vec<String> {
    let configured_printers: Vec<&str> = [
        settings.packing_slip_printer_name.trim(),
        settings.shipping_label_printer_name.trim(),
    ]
    .into_iter()
    .filter(|name| !name.is_empty())
    .collect();

    if configured_printers.is_empty() {
        return Vec::new();
    }

    if cfg!(target_os = "macos") {
        let output = Command::new("lpstat").args(["-p", "-d"]).output();
        let Ok(output) = output else {
            return vec![
                "Printer check failed: unable to run lpstat for configured printer validation."
                    .into(),
            ];
        };
        if !output.status.success() {
            return vec![
                "Printer check failed: lpstat returned an error while validating configured printers."
                    .into(),
            ];
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let available: Vec<String> = stdout
            .lines()
            .filter_map(|line| {
                line.strip_prefix("printer ")
                    .and_then(|value| value.split_whitespace().next())
                    .map(|value| value.trim().to_string())
            })
            .collect();
        let missing: Vec<&str> = configured_printers
            .into_iter()
            .filter(|name| !available.iter().any(|item| item == name))
            .collect();
        if missing.is_empty() {
            Vec::new()
        } else {
            vec![format!(
                "Configured printers not found: {}",
                missing.join(", ")
            )]
        }
    } else if cfg!(target_os = "windows") {
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-Printer | Select-Object -ExpandProperty Name",
            ])
            .output();
        let Ok(output) = output else {
            return vec!["Printer check failed: unable to query Windows printers.".into()];
        };
        if !output.status.success() {
            return vec![
                "Printer check failed: PowerShell returned an error while validating configured printers."
                    .into(),
            ];
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let available: Vec<String> = stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        let missing: Vec<&str> = configured_printers
            .into_iter()
            .filter(|name| !available.iter().any(|item| item == name))
            .collect();
        if missing.is_empty() {
            Vec::new()
        } else {
            vec![format!(
                "Configured printers not found: {}",
                missing.join(", ")
            )]
        }
    } else {
        vec!["Printer validation is not implemented for this platform.".into()]
    }
}

fn check_hot_folder_availability(settings: &WorkerSettings) -> Vec<String> {
    let folder_checks = [
        (
            "Download directory",
            settings.download_directory.trim(),
            false,
        ),
        ("Default hot folder", settings.hot_folder_path.trim(), false),
        (
            "Fuji hot folder",
            settings.photo_print_hot_folder_path.trim(),
            true,
        ),
        (
            "Sublimation hot folder",
            settings.photo_gift_hot_folder_path.trim(),
            false,
        ),
        (
            "Large format hot folder",
            settings.large_format_hot_folder_path.trim(),
            false,
        ),
    ];

    folder_checks
        .into_iter()
        .filter(|(_, raw, _)| !raw.is_empty())
        .filter_map(|(label, raw, advisory_only)| {
            validate_folder_access(label, raw, advisory_only).err().and_then(|error| {
                if advisory_only {
                    None
                } else {
                    Some(error)
                }
            })
        })
        .collect()
}

fn validate_folder_access(label: &str, raw_path: &str, allow_read_only: bool) -> Result<(), String> {
    let path = expand_user_path(raw_path);
    if path.exists() {
        if !path.is_dir() {
            return Err(format!("{label} is not a directory: {}", path.display()));
        }
        let metadata = fs::metadata(&path)
            .map_err(|err| format!("{label} is unavailable at {}: {err}", path.display()))?;
        if metadata.permissions().readonly() && !allow_read_only {
            return Err(format!("{label} is read-only: {}", path.display()));
        }
        return Ok(());
    }

    if allow_read_only {
        return Err(format!("{label} is unavailable at {}: path does not exist", path.display()));
    }

    fs::create_dir_all(&path)
        .map_err(|err| format!("{label} is unavailable at {}: {err}", path.display()))?;
    Ok(())
}

fn expand_user_path(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home).join(stripped);
        }
    }

    PathBuf::from(value)
}

fn chrono_like_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}
