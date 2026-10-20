//! Keeps a writing folder in sync with a vault on the sync server.
//!
//! The server is the source of truth for each file's version. This computer
//! remembers, per file, which version and content it last agreed on with the
//! server (`State`). A sync round:
//!
//! 1. **Pull**: fetch changes since the last one seen. A change to a file this
//!    computer hasn't touched since is simply written to disk (or the file is
//!    moved to the trash). If this computer changed it too, both are kept: the
//!    other computer's version is saved beside it as a "conflict" copy, and the
//!    local version goes up as the newest.
//! 2. **Push**: scan the folder; upload and commit whatever differs from the last
//!    agreed state, based on the version this computer last saw. If someone else
//!    got there first the server says so, and the round pulls again.
//!
//! Nothing is ever silently overwritten: every disagreement leaves both versions
//! on disk.

use super::client::{ApiError, Change, Client, CommitResult, RemoteEntry};
use super::crypto::VaultKey;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify};

/// Files bigger than this aren't synced (a writing folder shouldn't have any).
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// How long to wait after a local change before uploading, so a burst of saves goes up once.
pub const PUSH_DELAY: Duration = Duration::from_secs(2);
/// A full check even without nudges: catches edits made outside Joyce, and a dropped connection.
const SAFETY_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct FileState {
    pub id: String,
    /// Server version this computer last agreed on.
    pub version: u64,
    /// Content id agreed on; `None` when the agreed state is "deleted".
    pub blob: Option<String>,
    /// Disk mtime and size when last checked, to skip re-reading unchanged files.
    pub mtime: u64,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Default)]
pub struct State {
    /// Server change sequence number this computer has caught up to.
    pub seq: u64,
    /// Keyed by path relative to the writing folder, with `/` separators.
    pub files: BTreeMap<String, FileState>,
}

/// Encrypted alongside each entry on the server.
#[derive(Serialize, Deserialize)]
struct Meta {
    /// Path relative to the writing folder.
    p: String,
    /// Name of the computer that made the change.
    d: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Syncing,
    Idle { last_sync: u64 },
    Offline { message: String },
    /// This computer's access was revoked; sync has stopped.
    Removed,
    Error { message: String },
}

pub enum Event {
    Status(Status),
    /// Files (relative paths) changed on disk because of other computers.
    Changed(Vec<String>),
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Engine {
    pub root: PathBuf,
    pub device_name: String,
    key: VaultKey,
    client: Client,
    state: Mutex<State>,
    state_path: PathBuf,
    emit: Emit,
    nudge: Notify,
    remote: Notify,
    stop: tokio::sync::watch::Sender<bool>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Junk that shouldn't travel between computers.
fn ignored(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".git" | ".svn" | ".hg" | "node_modules" | ".Trash")
        || name.ends_with(".joyce-tmp")
        || name.starts_with("~$")
        || name.ends_with(".swp")
}

/// Joyce's own data files, as opposed to writing.
fn is_app_data(path: &str) -> bool {
    // Canvas cards contain a writer's ideas. Preserve concurrent versions just
    // like documents, even though the board lives alongside hidden app data.
    if let Some(name) = path.strip_prefix(".joyce/") {
        if name == "canvas.json" || (name.starts_with("canvas (") && name.ends_with(").json") && !name.contains('/')) {
            return false;
        }
    }
    path.starts_with(".joyce/") || path == ".joyce.json" || path.ends_with("/.joyce.json")
}

/// A path from the server is only accepted if it stays inside the writing folder.
fn safe_rel(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|c| !c.is_empty() && c != "." && c != ".." && !ignored(c))
}

impl Engine {
    pub fn new(root: PathBuf, device_name: String, key: VaultKey, client: Client, state_path: PathBuf, emit: Emit) -> Arc<Self> {
        let state = std::fs::read_to_string(&state_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let (stop, _) = tokio::sync::watch::channel(false);
        Arc::new(Self {
            root,
            device_name,
            key,
            client,
            state: Mutex::new(state),
            state_path,
            emit,
            nudge: Notify::new(),
            remote: Notify::new(),
            stop,
        })
    }

    /// Something changed locally; upload soon.
    pub fn nudge(&self) {
        self.nudge.notify_one();
    }

    pub fn stop(&self) {
        let _ = self.stop.send(true);
        self.nudge.notify_one();
        self.remote.notify_one();
    }

    fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn key(&self) -> &VaultKey {
        &self.key
    }

    /// Runs until stopped: a sync round at start, then whenever nudged, notified
    /// by the server, or every minute regardless.
    pub async fn run(self: Arc<Self>) {
        tokio::spawn(self.clone().listen());
        let mut stop = self.stop.subscribe();
        loop {
            if self.stopped() {
                break;
            }
            match self.sync_round().await {
                Err(ApiError::Unauthorized) => {
                    (self.emit)(Event::Status(Status::Removed));
                    break;
                }
                Err(ApiError::Network(e)) => (self.emit)(Event::Status(Status::Offline { message: e })),
                Err(e) => (self.emit)(Event::Status(Status::Error { message: e.to_string() })),
                Ok(()) => (self.emit)(Event::Status(Status::Idle { last_sync: now_ms() })),
            }
            tokio::select! {
                _ = self.remote.notified() => {}
                _ = async {
                    self.nudge.notified().await;
                    // Let a burst of saves settle before uploading.
                    tokio::time::sleep(PUSH_DELAY).await;
                } => {}
                _ = tokio::time::sleep(SAFETY_INTERVAL) => {}
                _ = stop.changed() => {}
            }
        }
    }

    /// Holds a WebSocket open to hear about other computers' changes, reconnecting as needed.
    async fn listen(self: Arc<Self>) {
        use futures_util::StreamExt;
        let mut backoff = Duration::from_secs(2);
        while !self.stopped() {
            let Ok(req) = self.client.ws_request() else { return };
            match tokio_tungstenite::connect_async(req).await {
                Ok((mut ws, _)) => {
                    backoff = Duration::from_secs(2);
                    let mut stop = self.stop.subscribe();
                    loop {
                        tokio::select! {
                            msg = ws.next() => match msg {
                                Some(Ok(m)) if m.is_text() => {
                                    let seq = serde_json::from_str::<serde_json::Value>(m.to_text().unwrap_or("{}"))
                                        .ok()
                                        .and_then(|v| v.get("seq").and_then(|s| s.as_u64()))
                                        .unwrap_or(0);
                                    if seq > self.state.lock().await.seq {
                                        self.remote.notify_one();
                                    }
                                }
                                Some(Ok(_)) => {}
                                _ => break,
                            },
                            // Keeps the connection alive through proxies; the server answers without waking up.
                            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                                use futures_util::SinkExt;
                                if ws.send(tokio_tungstenite::tungstenite::Message::text("ping")).await.is_err() { break; }
                            }
                            _ = stop.changed() => return,
                        }
                    }
                }
                Err(_) => {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        }
    }

    pub async fn sync_round(&self) -> Result<(), ApiError> {
        (self.emit)(Event::Status(Status::Syncing));
        // A conflict means another computer got there first: pull its change
        // (keeping both versions), then push again. Twice is plenty.
        for _ in 0..3 {
            self.pull().await?;
            if !self.push().await? {
                break;
            }
        }
        self.save_state().await;
        Ok(())
    }

    async fn save_state(&self) {
        let state = self.state.lock().await;
        if let Ok(json) = serde_json::to_string(&*state) {
            if let Some(dir) = self.state_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = self.state_path.with_extension("tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.state_path);
            }
        }
    }

    fn abs(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.root.clone(), |p, c| p.join(c))
    }

    // --- Pull ------------------------------------------------------------------

    async fn pull(&self) -> Result<(), ApiError> {
        let mut changed = BTreeSet::new();
        loop {
            let since = self.state.lock().await.seq;
            let batch = self.client.changes(since).await?;
            let last = batch.entries.last().map(|e| e.seq);
            for entry in &batch.entries {
                if let Some(path) = self.apply_remote(entry).await? {
                    changed.insert(path);
                }
            }
            let mut state = self.state.lock().await;
            state.seq = if batch.more { last.unwrap_or(state.seq) } else { batch.seq.max(state.seq) };
            drop(state);
            if !batch.more {
                break;
            }
        }
        if !changed.is_empty() {
            (self.emit)(Event::Changed(changed.into_iter().collect()));
        }
        Ok(())
    }

    /// Brings one remote change to disk. Returns the path if the disk changed.
    async fn apply_remote(&self, entry: &RemoteEntry) -> Result<Option<String>, ApiError> {
        let Ok(meta) = self.key.open_meta(&entry.meta).and_then(|m| serde_json::from_slice::<Meta>(&m).map_err(|e| e.to_string())) else {
            // Not ours to read (or damaged); nothing sensible to do with it.
            return Ok(None);
        };
        let path = meta.p;
        if !safe_rel(&path) {
            return Ok(None);
        }
        let known = self.state.lock().await.files.get(&path).cloned();
        if known.as_ref().is_some_and(|k| k.version >= entry.version) {
            return Ok(None); // Already have it (often our own change coming back).
        }

        let abs = self.abs(&path);
        let disk = std::fs::read(&abs).ok();
        let disk_blob = disk.as_ref().map(|d| self.key.blob_id(d));
        // Has this computer changed the file since it last agreed with the server?
        let locally_changed = match (&disk_blob, &known) {
            (None, None) => false,
            (Some(_), None) => true,
            (None, Some(k)) => k.blob.is_some(),
            (Some(b), Some(k)) => k.blob.as_deref() != Some(b.as_str()),
        };

        let agreed = |blob: Option<String>, meta: Option<&std::fs::Metadata>| FileState {
            id: entry.id.clone(),
            version: entry.version,
            blob,
            mtime: meta.map(mtime_ms).unwrap_or(0),
            size: meta.map(|m| m.len()).unwrap_or(0),
        };

        match &entry.blob {
            // Deleted elsewhere.
            None => {
                let mut state = self.state.lock().await;
                if locally_changed && disk.is_some() {
                    // An edit here beats a delete there: keep it, and it'll go back up.
                    state.files.insert(path, agreed(None, None));
                    return Ok(None);
                }
                state.files.remove(&path);
                drop(state);
                if disk.is_some() {
                    if crate::move_to_trash(&abs).is_err() {
                        let _ = std::fs::remove_file(&abs);
                    }
                    self.prune_empty_dirs(&abs);
                    return Ok(Some(path));
                }
                Ok(None)
            }
            Some(blob) => {
                if disk_blob.as_deref() == Some(blob.as_str()) {
                    // Same content already here (e.g. both computers made the same edit).
                    let meta = std::fs::metadata(&abs).ok();
                    self.state.lock().await.files.insert(path, agreed(Some(blob.clone()), meta.as_ref()));
                    return Ok(None);
                }
                let content = self.fetch(blob).await?;
                // Joyce's own bookkeeping (goals, outlines…) doesn't get conflict
                // copies: the newest version simply wins.
                if locally_changed && disk.is_some() && is_app_data(&path) {
                    self.state.lock().await.files.insert(path, agreed(Some(blob.clone()), None));
                    return Ok(None);
                }
                if locally_changed && disk.is_some() {
                    // Both changed it: keep ours in place, theirs beside it.
                    let copy = self.conflict_path(&path, &meta.d);
                    write_atomic(&self.abs(&copy), &content).map_err(|e| ApiError::Server(0, e))?;
                    // Agreeing on their version means ours now differs, and gets pushed as the newest.
                    self.state.lock().await.files.insert(path, agreed(Some(blob.clone()), None));
                    return Ok(Some(copy));
                }
                write_atomic(&abs, &content).map_err(|e| ApiError::Server(0, e))?;
                let meta = std::fs::metadata(&abs).ok();
                self.state.lock().await.files.insert(path.clone(), agreed(Some(blob.clone()), meta.as_ref()));
                Ok(Some(path))
            }
        }
    }

    async fn fetch(&self, blob: &str) -> Result<Vec<u8>, ApiError> {
        let sealed = self.client.download(blob).await?;
        let plain = self.key.open(&sealed).map_err(|e| ApiError::Server(0, e))?;
        // The id is a keyed hash of the content, so this also proves it's the right content.
        if self.key.blob_id(&plain) != blob {
            return Err(ApiError::Server(0, "Synced content didn't match its fingerprint".into()));
        }
        Ok(plain)
    }

    /// "Chapter 3.md" → "Chapter 3 (conflict from MacBook).md", numbered if taken.
    fn conflict_path(&self, path: &str, device: &str) -> String {
        let (dir, file) = path.rsplit_once('/').map(|(d, f)| (format!("{d}/"), f)).unwrap_or((String::new(), path));
        let (stem, ext) = match file.rfind('.') {
            Some(i) if i > 0 => (&file[..i], &file[i..]),
            _ => (file, ""),
        };
        let device: String = device.chars().filter(|c| !matches!(c, '/' | '\\' | ':')).collect();
        (1..)
            .map(|n| {
                let suffix = if n == 1 { String::new() } else { format!(" {n}") };
                format!("{dir}{stem} (conflict from {device}{suffix}){ext}")
            })
            .find(|p| !self.abs(p).exists())
            .unwrap()
    }

    /// After deleting a file that came from another computer, tidy folders it left empty.
    fn prune_empty_dirs(&self, file: &Path) {
        let mut dir = file.parent();
        while let Some(d) = dir {
            if d == self.root || std::fs::remove_dir(d).is_err() {
                break;
            }
            dir = d.parent();
        }
    }

    // --- Push ------------------------------------------------------------------

    fn scan(&self) -> HashMap<String, std::fs::Metadata> {
        let mut out = HashMap::new();
        let mut stack = vec![(self.root.clone(), String::new())];
        while let Some((dir, rel)) = stack.pop() {
            let Ok(items) = std::fs::read_dir(&dir) else { continue };
            for item in items.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if ignored(&name) {
                    continue;
                }
                let child_rel = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                let Ok(meta) = std::fs::symlink_metadata(item.path()) else { continue };
                if meta.is_dir() {
                    stack.push((item.path(), child_rel));
                } else if meta.is_file() && meta.len() <= MAX_FILE {
                    out.insert(child_rel, meta);
                }
            }
        }
        out
    }

    /// Uploads local changes. Returns whether any were refused as conflicts.
    async fn push(&self) -> Result<bool, ApiError> {
        struct Pending {
            path: String,
            base: u64,
            blob: Option<String>,
            content: Option<Vec<u8>>,
            meta: Option<std::fs::Metadata>,
        }
        let disk = self.scan();
        let mut pending = vec![];
        {
            let mut state = self.state.lock().await;
            for (path, meta) in &disk {
                let known = state.files.get(path);
                if known.is_some_and(|k| k.blob.is_some() && k.mtime == mtime_ms(meta) && k.size == meta.len()) {
                    continue; // Untouched since last check.
                }
                let Ok(content) = std::fs::read(self.abs(path)) else { continue };
                let blob = self.key.blob_id(&content);
                if let Some(k) = state.files.get_mut(path) {
                    if k.blob.as_deref() == Some(blob.as_str()) {
                        // Touched but not changed; remember the new timestamp.
                        k.mtime = mtime_ms(meta);
                        k.size = meta.len();
                        continue;
                    }
                }
                let base = state.files.get(path).map(|k| k.version).unwrap_or(0);
                pending.push(Pending { path: path.clone(), base, blob: Some(blob), content: Some(content), meta: Some(meta.clone()) });
            }
            for (path, k) in &state.files {
                if k.blob.is_some() && !disk.contains_key(path) {
                    pending.push(Pending { path: path.clone(), base: k.version, blob: None, content: None, meta: None });
                }
            }
        }
        if pending.is_empty() {
            return Ok(false);
        }

        // Upload content the server doesn't have yet (identical text is stored once).
        let mut sealed: HashMap<String, Vec<u8>> = HashMap::new();
        for p in &pending {
            if let (Some(b), Some(c)) = (&p.blob, &p.content) {
                sealed.entry(b.clone()).or_insert_with(|| self.key.seal_content(c));
            }
        }
        let ids: Vec<String> = sealed.keys().cloned().collect();
        for id in self.client.missing(&ids).await? {
            if let Some(data) = sealed.get(&id) {
                self.client.upload(&id, data).await?;
            }
        }

        let changes: Vec<Change> = pending
            .iter()
            .map(|p| {
                let meta = serde_json::to_vec(&Meta { p: p.path.clone(), d: self.device_name.clone() }).unwrap_or_default();
                Change { id: self.key.file_id(&p.path), base: p.base, blob: p.blob.clone(), meta: self.key.seal_meta(&meta) }
            })
            .collect();
        let results = self.client.commit(&changes).await?;

        let mut conflicted = false;
        let mut state = self.state.lock().await;
        for (p, result) in pending.iter().zip(results) {
            match result {
                CommitResult::Ok { version } => match &p.blob {
                    Some(blob) => {
                        let m = p.meta.as_ref();
                        state.files.insert(
                            p.path.clone(),
                            FileState {
                                id: self.key.file_id(&p.path),
                                version,
                                blob: Some(blob.clone()),
                                mtime: m.map(mtime_ms).unwrap_or(0),
                                size: m.map(|m| m.len()).unwrap_or(0),
                            },
                        );
                    }
                    None => {
                        state.files.remove(&p.path);
                    }
                },
                CommitResult::Conflict { .. } => conflicted = true,
                CommitResult::Error { error } => return Err(ApiError::Server(0, error)),
            }
        }
        Ok(conflicted)
    }
}

/// Writes via a temp file and rename, creating folders as needed.
fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.joyce-tmp"));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_ideas_keep_conflicting_versions() {
        assert!(!is_app_data(".joyce/canvas.json"));
        assert!(!is_app_data(".joyce/canvas (conflict from B).json"));
        assert!(!is_app_data("Novel/.joyce/canvas.json"), "each project's own board");
        assert!(!is_app_data("Novel/.joyce/canvas (conflict from B).json"));
        assert!(is_app_data(".joyce/goals.json"));
        assert!(is_app_data(".joyce/canvas-settings.json"));
        assert!(is_app_data("Novel/.joyce.json"));
    }

    #[test]
    fn paths_from_the_server_must_stay_inside() {
        assert!(safe_rel("Novel/One.md"));
        assert!(safe_rel(".joyce/goals.json"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "C:/x", "a\\b", ".git/config", "./a"] {
            assert!(!safe_rel(bad), "{bad}");
        }
    }
}

/// Two computers syncing through a real server. Needs `wrangler dev` running in
/// sync-server/ with fresh storage:
/// `JOYCE_SYNC_SERVER=http://localhost:8787 cargo test two_computers -- --ignored --nocapture`
#[cfg(test)]
mod two_computers {
    use super::super::{client, crypto};
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn server() -> String {
        std::env::var("JOYCE_SYNC_SERVER").unwrap_or_else(|_| "http://localhost:8787".into())
    }

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("joyce-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(root: &Path, rel: &str, content: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    fn read(root: &Path, rel: &str) -> Option<String> {
        std::fs::read_to_string(root.join(rel)).ok()
    }

    fn engine(root: &Path, name: &str, key: VaultKey, token: &str, log: Arc<StdMutex<Vec<String>>>) -> Arc<Engine> {
        Engine::new(
            root.to_path_buf(),
            name.into(),
            key,
            Client::new(&server(), token),
            root.with_extension("state.json"),
            Arc::new(move |e| {
                if let Event::Changed(paths) = e {
                    log.lock().unwrap().extend(paths);
                }
            }),
        )
    }

    // Distinct mtimes, so a rewrite of the same size is never mistaken for "untouched".
    async fn tick() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    #[tokio::test]
    #[ignore]
    async fn two_computers() {
        let (dir_a, dir_b) = (temp("a"), temp("b"));
        let log_b = Arc::new(StdMutex::new(vec![]));

        // Computer A has a project with an image and app data.
        write(&dir_a, "Novel/One.md", b"# One\n\nStately, plump Buck Mulligan.");
        write(&dir_a, "Novel/Two.md", b"Second.");
        write(&dir_a, "Novel/.joyce.json", br#"{"project":true,"order":["One.md","Two.md"]}"#);
        write(&dir_a, "Novel/assets/pic.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 255]);
        write(&dir_a, ".joyce/goals.json", br#"{"daily":500}"#);
        write(&dir_a, ".DS_Store", b"junk");

        let created = client::create_vault(&server(), "A").await.expect("create vault");
        let key_a = VaultKey::generate();
        let a = engine(&dir_a, "A", VaultKey::from_base64(&key_a.to_base64()).unwrap(), &created.token, Arc::new(StdMutex::new(vec![])));
        a.sync_round().await.expect("A first sync");

        // The server never sees readable text.
        let state = a.state.lock().await;
        let one = state.files.get("Novel/One.md").expect("One synced").clone();
        assert!(!state.files.contains_key(".DS_Store"), "junk isn't synced");
        drop(state);
        let raw = a.client.download(one.blob.as_ref().unwrap()).await.unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Mulligan"), "content is encrypted on the server");

        // Computer B pairs with a code and gets everything.
        let code = crypto::new_pairing_code();
        let (lookup, pk) = crypto::pairing_keys(&code).unwrap();
        a.client.create_pairing(&lookup, &crypto::seal_for_pairing(&pk, &key_a)).await.unwrap();
        let typed = code.to_lowercase();
        let (lookup_b, pk_b) = crypto::pairing_keys(&typed).unwrap();
        let claimed = client::claim_pairing(&server(), &lookup_b, "B").await.expect("claim");
        let key_b = crypto::open_from_pairing(&pk_b, claimed.sealed.as_deref().unwrap()).unwrap();
        let b = engine(&dir_b, "B", key_b, &claimed.token, log_b.clone());
        b.sync_round().await.expect("B first sync");
        assert_eq!(read(&dir_b, "Novel/One.md").as_deref(), Some("# One\n\nStately, plump Buck Mulligan."));
        assert_eq!(std::fs::read(dir_b.join("Novel/assets/pic.png")).unwrap(), vec![0x89, b'P', b'N', b'G', 0, 1, 2, 255]);
        assert_eq!(read(&dir_b, ".joyce/goals.json").as_deref(), Some(r#"{"daily":500}"#));
        assert!(!dir_b.join(".DS_Store").exists());
        assert!(log_b.lock().unwrap().contains(&"Novel/One.md".to_string()), "UI is told what changed");

        // An edit on B arrives on A.
        tick().await;
        write(&dir_b, "Novel/Two.md", b"Second, revised on B.");
        b.sync_round().await.unwrap();
        a.sync_round().await.unwrap();
        assert_eq!(read(&dir_a, "Novel/Two.md").as_deref(), Some("Second, revised on B."));

        // Both edit the same chapter before syncing: both versions survive.
        tick().await;
        write(&dir_a, "Novel/One.md", b"A's version");
        write(&dir_b, "Novel/One.md", b"B's version");
        b.sync_round().await.unwrap();
        a.sync_round().await.unwrap();
        assert_eq!(read(&dir_a, "Novel/One.md").as_deref(), Some("A's version"), "local edit stays in place");
        assert_eq!(read(&dir_a, "Novel/One (conflict from B).md").as_deref(), Some("B's version"), "the other edit is kept beside it");
        b.sync_round().await.unwrap();
        assert_eq!(read(&dir_b, "Novel/One.md").as_deref(), Some("A's version"), "everyone converges");
        assert_eq!(read(&dir_b, "Novel/One (conflict from B).md").as_deref(), Some("B's version"));

        // App data: newest wins, no conflict copies.
        tick().await;
        write(&dir_a, ".joyce/goals.json", br#"{"daily":600}"#);
        write(&dir_b, ".joyce/goals.json", br#"{"daily":700}"#);
        b.sync_round().await.unwrap();
        a.sync_round().await.unwrap();
        b.sync_round().await.unwrap();
        let goals = read(&dir_a, ".joyce/goals.json").unwrap();
        assert_eq!(read(&dir_b, ".joyce/goals.json").unwrap(), goals, "converged");
        assert!(!dir_a.join(".joyce/goals (conflict from B).json").exists());

        // Renames and deletes travel; nothing comes back from the dead.
        tick().await;
        std::fs::rename(dir_a.join("Novel/Two.md"), dir_a.join("Novel/Second.md")).unwrap();
        std::fs::remove_file(dir_a.join("Novel/One (conflict from B).md")).unwrap();
        a.sync_round().await.unwrap();
        b.sync_round().await.unwrap();
        assert!(!dir_b.join("Novel/Two.md").exists());
        assert_eq!(read(&dir_b, "Novel/Second.md").as_deref(), Some("Second, revised on B."));
        assert!(!dir_b.join("Novel/One (conflict from B).md").exists());
        a.sync_round().await.unwrap();
        assert!(!dir_a.join("Novel/Two.md").exists(), "deleted files stay deleted");

        // An edit beats a delete made elsewhere.
        tick().await;
        std::fs::remove_file(dir_a.join("Novel/Second.md")).unwrap();
        write(&dir_b, "Novel/Second.md", b"Edited while A deleted it");
        a.sync_round().await.unwrap();
        b.sync_round().await.unwrap();
        a.sync_round().await.unwrap();
        assert_eq!(read(&dir_a, "Novel/Second.md").as_deref(), Some("Edited while A deleted it"));

        // Removing a computer stops it syncing.
        b.client.remove_device(&created.device_id).await.unwrap();
        assert!(matches!(a.sync_round().await, Err(ApiError::Unauthorized)));
        println!("two computers: all good");
    }
}
