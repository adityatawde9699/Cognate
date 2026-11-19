//! Built-in llama.cpp inference: runs a GGUF model inside the app process, so
//! no separate server (Ollama, llama-server) is needed.
//!
//! * Models live in `<app data>/models/` and are downloaded on request from a
//!   pinned Hugging Face revision, then verified against a SHA-256 checksum.
//! * GPU: when the binary was built with CUDA (or Metal on macOS) and a GPU
//!   device is present, every layer is offloaded. If no GPU is found, or the GPU
//!   load fails (for example not enough VRAM), the model loads on the CPU.
//! * Nothing here talks to a network except the explicit model download.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
};
use tauri::{Emitter, Manager};

/// One downloadable model. Revision and checksum are pinned so a download is
/// reproducible and tamper-evident.
pub struct CatalogModel {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    /// Context window used for this model (tokens).
    #[cfg_attr(not(feature = "embedded-llm"), allow(dead_code))]
    pub n_ctx: u32,
}

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen2.5-0.5b",
        label: "Qwen 2.5 0.5B (fastest)",
        blurb: "Smallest download. Good for quick estimates on any machine.",
        repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        revision: "9217f5db79a29953eb74d5343926648285ec7e67",
        file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
        size_bytes: 491_400_032,
        n_ctx: 4096,
    },
    CatalogModel {
        id: "qwen2.5-1.5b",
        label: "Qwen 2.5 1.5B (balanced)",
        blurb: "Better estimates and briefs; fine on a laptop CPU.",
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        revision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
        size_bytes: 1_117_320_736,
        n_ctx: 4096,
    },
    CatalogModel {
        id: "llama3.2-3b",
        label: "Llama 3.2 3B (best quality)",
        blurb: "Highest quality here. Wants a GPU or a fast CPU and about 3 GB of memory.",
        repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
        revision: "5ab33fa94d1d04e903623ae72c95d1696f09f9e8",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
        size_bytes: 2_019_377_696,
        n_ctx: 4096,
    },
];

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create models directory: {e}"))?;
    Ok(dir)
}

fn model_path(dir: &Path, m: &CatalogModel) -> PathBuf {
    dir.join(m.file)
}

/// Which accelerator this build and machine can use.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    /// "cuda", "metal", "vulkan", or "cpu".
    pub backend: String,
    /// GPU name, when one is usable.
    pub device: Option<String>,
    pub vram_mb: Option<u64>,
    /// Whether this build includes the embedded engine at all.
    pub engine: bool,
    /// Whether layers will be offloaded to the GPU.
    pub gpu: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub size_bytes: u64,
    pub installed: bool,
    pub downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmStatus {
    pub hardware: Hardware,
    pub models: Vec<ModelStatus>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    id: &'a str,
    received: u64,
    total: u64,
    /// "downloading" | "verifying" | "done" | "error" | "cancelled"
    phase: &'a str,
    error: Option<String>,
}

#[derive(Default)]
pub struct LocalLlm {
    downloads: StdMutex<HashMap<String, Arc<AtomicBool>>>,
    #[cfg(feature = "embedded-llm")]
    engine: engine::Engine,
}

// ── Download ────────────────────────────────────────────────

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn is_installed(dir: &Path, m: &CatalogModel) -> bool {
    std::fs::metadata(model_path(dir, m))
        .map(|meta| meta.len() == m.size_bytes)
        .unwrap_or(false)
}

#[tauri::command]
pub async fn local_llm_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlm>,
) -> Result<LocalLlmStatus, String> {
    let dir = models_dir(&app)?;
    let active = state.downloads.lock().map_err(|e| e.to_string())?;
    Ok(LocalLlmStatus {
        hardware: detect_hardware(),
        models: CATALOG
            .iter()
            .map(|m| ModelStatus {
                id: m.id,
                label: m.label,
                blurb: m.blurb,
                size_bytes: m.size_bytes,
                installed: is_installed(&dir, m),
                downloading: active.contains_key(m.id),
            })
            .collect(),
    })
}

fn emit(app: &tauri::AppHandle, p: DownloadProgress<'_>) {
    let _ = app.emit("local-llm-download", p);
}

#[tauri::command]
pub async fn local_llm_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlm>,
    id: String,
) -> Result<(), String> {
    let model = find(&id).ok_or("Unknown model")?;
    let dir = models_dir(&app)?;
    if is_installed(&dir, model) {
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.downloads.lock().map_err(|e| e.to_string())?;
        if active.contains_key(model.id) {
            return Err("This model is already downloading".into());
        }
        active.insert(model.id.to_string(), cancel.clone());
    }
    let result = download(&app, &dir, model, &cancel).await;
    state
        .downloads
        .lock()
        .map_err(|e| e.to_string())?
        .remove(model.id);
    match &result {
        Ok(()) => emit(
            &app,
            DownloadProgress {
                id: model.id,
                received: model.size_bytes,
                total: model.size_bytes,
                phase: "done",
                error: None,
            },
        ),
        Err(e) if e == "cancelled" => emit(
            &app,
            DownloadProgress {
                id: model.id,
                received: 0,
                total: model.size_bytes,
                phase: "cancelled",
                error: None,
            },
        ),
        Err(e) => emit(
            &app,
            DownloadProgress {
                id: model.id,
                received: 0,
                total: model.size_bytes,
                phase: "error",
                error: Some(e.clone()),
            },
        ),
    }
    result
}

async fn download(
    app: &tauri::AppHandle,
    dir: &Path,
    model: &CatalogModel,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        model.repo, model.revision, model.file
    );
    let part = dir.join(format!("{}.part", model.file));
    let final_path = model_path(dir, model);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "Could not reach the model host. Check your connection.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "Model host rejected the download (HTTP {}).",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(model.size_bytes);
    if total != model.size_bytes {
        return Err("Model size does not match the expected file.".into());
    }
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("Cannot write model file: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let outcome: Result<(), String> = async {
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|_| "Download interrupted. Try again.".to_string())?
        {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            received += chunk.len() as u64;
            if received > model.size_bytes {
                return Err("Model is larger than expected.".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Cannot write model file: {e}"))?;
            if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
                last_emit = std::time::Instant::now();
                emit(
                    app,
                    DownloadProgress {
                        id: model.id,
                        received,
                        total,
                        phase: "downloading",
                        error: None,
                    },
                );
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = outcome {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    emit(
        app,
        DownloadProgress {
            id: model.id,
            received,
            total,
            phase: "verifying",
            error: None,
        },
    );
    let part_for_hash = part.clone();
    let digest = tokio::task::spawn_blocking(move || sha256_file(&part_for_hash))
        .await
        .map_err(|e| e.to_string())??;
    if digest != model.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("Downloaded file failed its integrity check and was discarded.".into());
    }
    tokio::fs::rename(&part, &final_path)
        .await
        .map_err(|e| format!("Cannot finalize model file: {e}"))
}

#[tauri::command]
pub fn local_llm_cancel_download(
    state: tauri::State<'_, LocalLlm>,
    id: String,
) -> Result<(), String> {
    if let Some(flag) = state.downloads.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn local_llm_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlm>,
    id: String,
) -> Result<(), String> {
    let model = find(&id).ok_or("Unknown model")?;
    #[cfg(feature = "embedded-llm")]
    state.engine.unload();
    #[cfg(not(feature = "embedded-llm"))]
    let _ = &state;
    let path = model_path(&models_dir(&app)?, model);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot delete model: {e}")),
    }
}

// ── Generation entry point (called from ai.rs for provider "embedded") ──

pub async fn generate(
    app: &tauri::AppHandle,
    model_id: &str,
    system: Option<&str>,
    prompt: &str,
    max_tokens: u32,
) -> Result<String, String> {
    #[cfg(feature = "embedded-llm")]
    {
        let model = find(model_id).ok_or("Choose a built-in model in Settings → AI.")?;
        let dir = models_dir(app)?;
        if !is_installed(&dir, model) {
            return Err(format!(
                "The built-in model \"{}\" is not downloaded yet. Download it in Settings → AI.",
                model.label
            ));
        }
        let path = model_path(&dir, model);
        let state = app.state::<LocalLlm>();
        let engine = state.engine.clone_handle();
        let system = system.map(str::to_string);
        let prompt = prompt.to_string();
        let n_ctx = model.n_ctx;
        let id = model.id;
        tokio::task::spawn_blocking(move || {
            engine.generate(id, &path, n_ctx, system.as_deref(), &prompt, max_tokens)
        })
        .await
        .map_err(|e| format!("Built-in model stopped unexpectedly: {e}"))?
    }
    #[cfg(not(feature = "embedded-llm"))]
    {
        let _ = (app, model_id, system, prompt, max_tokens);
        Err("This build does not include the built-in model engine.".into())
    }
}

pub fn detect_hardware() -> Hardware {
    #[cfg(feature = "embedded-llm")]
    {
        engine::detect()
    }
    #[cfg(not(feature = "embedded-llm"))]
    {
        Hardware {
            backend: "cpu".into(),
            device: None,
            vram_mb: None,
            engine: false,
            gpu: false,
        }
    }
}

#[cfg(feature = "embedded-llm")]
mod engine {
    use super::Hardware;
    use llama_cpp_2::{
        context::params::LlamaContextParams,
        list_llama_ggml_backend_devices,
        llama_backend::LlamaBackend,
        llama_batch::LlamaBatch,
        model::{params::LlamaModelParams, LlamaChatMessage, LlamaModel},
        sampling::LlamaSampler,
        LlamaBackendDeviceType,
    };
    use std::{
        num::NonZeroU32,
        path::Path,
        sync::{Arc, Mutex, OnceLock},
    };

    /// With the GPU build, ggml backends (CUDA, CPU variants) are modules loaded
    /// at run time. A module that cannot load (no NVIDIA driver, wrong GPU) is
    /// skipped, which leaves the CPU backend: that is the CPU fallback.
    #[cfg(feature = "embedded-llm-gpu")]
    fn load_backend_modules() {
        let mut dirs: Vec<std::path::PathBuf> = Vec::new();
        if let Some(dir) = std::env::var_os("COGNATE_LLM_BACKENDS") {
            dirs.push(dir.into());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                dirs.push(parent.join("llm-backends"));
                dirs.push(parent.to_path_buf());
            }
        }
        let mut loaded = false;
        for dir in dirs.iter().filter(|d| d.is_dir()) {
            llama_cpp_2::llama_backend::load_backends_from_path(dir);
            loaded = true;
            break;
        }
        if !loaded {
            // Development builds: the directory the build script installed into.
            llama_cpp_2::llama_backend::load_backends();
        }
    }
    #[cfg(not(feature = "embedded-llm-gpu"))]
    fn load_backend_modules() {}

    /// The llama.cpp backend may only be initialised once per process.
    fn backend() -> Result<&'static LlamaBackend, String> {
        static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
        BACKEND
            .get_or_init(|| {
                load_backend_modules();
                let mut b =
                    LlamaBackend::init().map_err(|e| format!("llama.cpp init failed: {e}"))?;
                b.void_logs();
                Ok(b)
            })
            .as_ref()
            .map_err(|e| e.clone())
    }

    /// A usable discrete or integrated GPU, if this build can offload to one.
    fn gpu_device() -> Option<(String, String, usize)> {
        if backend().is_err() {
            return None;
        }
        list_llama_ggml_backend_devices()
            .into_iter()
            .filter(|d| {
                matches!(
                    d.device_type,
                    LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu
                )
            })
            // Prefer a discrete GPU, then the one with the most memory.
            .max_by_key(|d| {
                (
                    matches!(d.device_type, LlamaBackendDeviceType::Gpu),
                    d.memory_total,
                )
            })
            .map(|d| (d.backend.to_lowercase(), d.description, d.memory_total))
    }

    pub fn detect() -> Hardware {
        match gpu_device() {
            Some((backend, description, mem)) => Hardware {
                backend,
                device: Some(description),
                vram_mb: Some((mem / (1024 * 1024)) as u64),
                engine: true,
                gpu: true,
            },
            None => Hardware {
                backend: "cpu".into(),
                device: None,
                vram_mb: None,
                engine: true,
                gpu: false,
            },
        }
    }

    struct Loaded {
        id: &'static str,
        model: LlamaModel,
        on_gpu: bool,
    }

    #[derive(Default)]
    pub struct Engine {
        loaded: Arc<Mutex<Option<Loaded>>>,
    }

    #[derive(Clone)]
    pub struct EngineHandle {
        loaded: Arc<Mutex<Option<Loaded>>>,
    }

    impl Engine {
        pub fn clone_handle(&self) -> EngineHandle {
            EngineHandle {
                loaded: self.loaded.clone(),
            }
        }
        pub fn unload(&self) {
            if let Ok(mut slot) = self.loaded.lock() {
                *slot = None;
            }
        }
    }

    fn load(path: &Path, want_gpu: bool) -> Result<LlamaModel, String> {
        let b = backend()?;
        // 999 layers == "everything"; llama.cpp clamps to the model's layer count.
        let params = LlamaModelParams::default().with_n_gpu_layers(if want_gpu { 999 } else { 0 });
        LlamaModel::load_from_file(b, path, &params).map_err(|e| e.to_string())
    }

    impl EngineHandle {
        #[cfg(test)]
        pub fn on_gpu(&self) -> Option<bool> {
            self.loaded.lock().ok()?.as_ref().map(|l| l.on_gpu)
        }
        pub fn generate(
            &self,
            id: &'static str,
            path: &Path,
            n_ctx: u32,
            system: Option<&str>,
            prompt: &str,
            max_tokens: u32,
        ) -> Result<String, String> {
            let mut slot = self
                .loaded
                .lock()
                .map_err(|_| "Built-in model is busy".to_string())?;
            if slot.as_ref().map(|l| l.id) != Some(id) {
                *slot = None;
                let gpu = gpu_device().is_some();
                // Try the GPU first; if it fails (no VRAM, driver trouble), run on the CPU.
                let (model, on_gpu) = if gpu {
                    match load(path, true) {
                        Ok(m) => (m, true),
                        Err(e) => {
                            log::warn!("GPU model load failed ({e}); falling back to CPU");
                            (load(path, false)?, false)
                        }
                    }
                } else {
                    (load(path, false)?, false)
                };
                *slot = Some(Loaded { id, model, on_gpu });
            }
            let loaded = slot.as_ref().expect("model loaded above");
            match run(loaded, n_ctx, system, prompt, max_tokens) {
                // A GPU run that fails mid-way (out of memory) is retried once on the CPU.
                Err(e) if loaded.on_gpu => {
                    log::warn!("GPU generation failed ({e}); retrying on CPU");
                    *slot = None;
                    let model = load(path, false)?;
                    *slot = Some(Loaded {
                        id,
                        model,
                        on_gpu: false,
                    });
                    run(
                        slot.as_ref().expect("model loaded above"),
                        n_ctx,
                        system,
                        prompt,
                        max_tokens,
                    )
                }
                other => other,
            }
        }
    }

    fn run(
        loaded: &Loaded,
        n_ctx: u32,
        system: Option<&str>,
        prompt: &str,
        max_tokens: u32,
    ) -> Result<String, String> {
        let b = backend()?;
        let model = &loaded.model;

        let mut messages = Vec::new();
        if let Some(s) = system {
            messages
                .push(LlamaChatMessage::new("system".into(), s.into()).map_err(|e| e.to_string())?);
        }
        messages
            .push(LlamaChatMessage::new("user".into(), prompt.into()).map_err(|e| e.to_string())?);
        let template = model
            .chat_template(None)
            .map_err(|_| "This model has no chat template.".to_string())?;
        let text = model
            .apply_chat_template(&template, &messages, true)
            .map_err(|e| e.to_string())?;
        // The template already contains the special tokens.
        let vocab = model.vocab();
        let tokens = vocab.tokenize(text.as_bytes(), false, true);

        let max_new = max_tokens.clamp(16, 4096) as usize;
        if tokens.len() + max_new > n_ctx as usize {
            return Err("The request is too long for the built-in model. Try fewer tasks.".into());
        }

        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .clamp(1, 16);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(n_ctx)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model
            .new_context(b, ctx_params)
            .map_err(|e| format!("Cannot create model context: {e}"))?;

        let mut batch = LlamaBatch::new(n_ctx as usize, 1);
        let last = tokens.len() as i32 - 1;
        for (i, t) in tokens.iter().enumerate() {
            batch
                .add(*t, i as i32, &[0], i as i32 == last)
                .map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| format!("Model evaluation failed: {e}"))?;

        // Low temperature keeps JSON-shaped answers stable.
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::top_k(40),
            LlamaSampler::top_p(0.9, 1),
            LlamaSampler::temp(0.2),
            LlamaSampler::dist(1234),
        ]);

        let mut out: Vec<u8> = Vec::new();
        for pos in (tokens.len() as i32..).take(max_new) {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if vocab.is_eog(token) {
                break;
            }
            out.extend(vocab.token_to_piece(token, false, None));
            batch.clear();
            batch
                .add(token, pos, &[0], true)
                .map_err(|e| e.to_string())?;
            ctx.decode(&mut batch)
                .map_err(|e| format!("Model evaluation failed: {e}"))?;
        }
        let text = String::from_utf8_lossy(&out).trim().to_string();
        if text.is_empty() {
            return Err("The built-in model returned no text.".into());
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_well_formed() {
        let mut ids = std::collections::HashSet::new();
        for m in CATALOG {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert_eq!(m.revision.len(), 40, "revision must be a pinned commit");
            assert!(m.file.ends_with(".gguf"));
            assert!(m.size_bytes > 100_000_000);
            assert!(!m.file.contains('/') && !m.file.contains(".."));
        }
    }

    #[test]
    fn unknown_models_are_rejected() {
        assert!(find("nope").is_none());
        assert!(find("qwen2.5-0.5b").is_some());
    }

    #[test]
    fn install_check_requires_exact_size() {
        let dir = std::env::temp_dir().join(format!("cognate-llm-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = &CATALOG[0];
        assert!(!is_installed(&dir, m));
        std::fs::write(model_path(&dir, m), b"truncated").unwrap();
        assert!(!is_installed(&dir, m));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Run with: COGNATE_TEST_GGUF=/path/model.gguf cargo test --lib real_model -- --ignored --nocapture
    #[cfg(feature = "embedded-llm")]
    #[test]
    #[ignore = "needs a GGUF model file"]
    fn real_model_generates_text() {
        let Some(path) = std::env::var_os("COGNATE_TEST_GGUF") else {
            panic!("set COGNATE_TEST_GGUF to a .gguf path");
        };
        let hw = detect_hardware();
        println!("hardware: {hw:?}");
        let engine = engine::Engine::default();
        let handle = engine.clone_handle();
        let start = std::time::Instant::now();
        let out = handle
            .generate(
                "qwen2.5-0.5b",
                std::path::Path::new(&path),
                4096,
                Some("You size tasks. Reply with only a JSON array."),
                "Tasks:\nid=a | Write the quarterly report | effort=4\nReturn [{\"id\":\"a\",\"duration_min\":N}] where N is a multiple of 15.",
                128,
            )
            .expect("generation failed");
        println!(
            "on_gpu={:?} elapsed={:?}\noutput: {out}",
            handle.on_gpu(),
            start.elapsed()
        );
        assert!(!out.is_empty());
        if std::env::var_os("COGNATE_EXPECT_GPU").is_some() {
            assert_eq!(handle.on_gpu(), Some(true), "expected the model on the GPU");
        }
    }

    #[test]
    fn checksum_matches_known_vector() {
        let p = std::env::temp_dir().join(format!("cognate-sha-{}", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(&p).unwrap();
    }
}
