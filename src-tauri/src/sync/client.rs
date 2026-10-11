//! Talks to the sync server (sync-server/ in this repo). Everything sent is
//! already encrypted; see crypto.rs.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Content is uploaded in pieces of at most this size (the server stores rows up to 2 MB).
pub const CHUNK: usize = 1024 * 1024;

#[derive(Debug)]
pub enum ApiError {
    /// This computer's token was rejected, e.g. it was removed from the vault.
    Unauthorized,
    /// Couldn't reach the server (offline, DNS, timeout…).
    Network(String),
    Server(u16, String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ApiError::Unauthorized => write!(f, "This computer isn't allowed to sync with that vault any more."),
            ApiError::Network(e) => write!(f, "Can't reach the sync server ({e})."),
            ApiError::Server(status, msg) => write!(f, "{msg} (HTTP {status})"),
        }
    }
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        e.to_string()
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct RemoteEntry {
    pub id: String,
    pub version: u64,
    pub blob: Option<String>,
    pub meta: String,
    pub seq: u64,
}

#[derive(Deserialize)]
pub struct Changes {
    pub seq: u64,
    pub entries: Vec<RemoteEntry>,
    pub more: bool,
}

#[derive(Serialize)]
pub struct Change {
    pub id: String,
    pub base: u64,
    pub blob: Option<String>,
    pub meta: String,
}

#[derive(Deserialize, Debug)]
pub struct Conflict {
    pub version: u64,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum CommitResult {
    Ok { version: u64 },
    Conflict { conflict: Conflict },
    Error { error: String },
}

#[derive(Deserialize)]
struct CommitResponse {
    results: Vec<CommitResult>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewDevice {
    pub vault_id: String,
    pub device_id: String,
    pub token: String,
    /// Only when joining: the vault key, sealed with the pairing code.
    #[serde(default)]
    pub sealed: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub last_seen: u64,
    pub current: bool,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Joyce-Sync")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("HTTP client")
}

async fn read<T: for<'de> Deserialize<'de>>(res: Result<reqwest::Response, reqwest::Error>) -> Result<T, ApiError> {
    let res = res.map_err(|e| ApiError::Network(e.to_string()))?;
    let status = res.status().as_u16();
    if status == 401 {
        return Err(ApiError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        let msg = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| "The sync server returned an error".into());
        return Err(ApiError::Server(status, msg));
    }
    res.json::<T>().await.map_err(|e| ApiError::Network(e.to_string()))
}

pub fn normalize_server(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Creates a vault (the first computer to sync). Later vaults need an existing device's token.
pub async fn create_vault(server: &str, device_name: &str) -> Result<NewDevice, ApiError> {
    read(http().post(format!("{}/v1/vaults", normalize_server(server))).json(&serde_json::json!({ "deviceName": device_name })).send().await).await
}

/// Joins a vault with the lookup id derived from a pairing code.
pub async fn claim_pairing(server: &str, lookup: &str, device_name: &str) -> Result<NewDevice, ApiError> {
    read(
        http()
            .post(format!("{}/v1/pairings/claim", normalize_server(server)))
            .json(&serde_json::json!({ "lookup": lookup, "deviceName": device_name }))
            .send()
            .await,
    )
    .await
}

impl Client {
    pub fn new(server: &str, token: &str) -> Self {
        Self { http: http(), base: normalize_server(server), token: token.to_string() }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1{}", self.base, path)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.bearer_auth(&self.token)
    }

    pub async fn changes(&self, since: u64) -> Result<Changes, ApiError> {
        read(self.auth(self.http.get(self.url(&format!("/changes?since={since}&limit=500")))).send().await).await
    }

    pub async fn missing(&self, ids: &[String]) -> Result<Vec<String>, ApiError> {
        #[derive(Deserialize)]
        struct R {
            missing: Vec<String>,
        }
        let mut out = vec![];
        for batch in ids.chunks(1000) {
            let r: R = read(self.auth(self.http.post(self.url("/missing"))).json(&serde_json::json!({ "ids": batch })).send().await).await?;
            out.extend(r.missing);
        }
        Ok(out)
    }

    /// Uploads encrypted content in chunks.
    pub async fn upload(&self, id: &str, sealed: &[u8]) -> Result<(), ApiError> {
        let pieces: Vec<&[u8]> = if sealed.is_empty() { vec![&[][..]] } else { sealed.chunks(CHUNK).collect() };
        let total = pieces.len();
        for (i, piece) in pieces.into_iter().enumerate() {
            let url = self.url(&format!("/blobs/{id}/{i}?of={total}&size={}", sealed.len()));
            let _: serde_json::Value = read(self.auth(self.http.put(url)).body(piece.to_vec()).send().await).await?;
        }
        Ok(())
    }

    pub async fn download(&self, id: &str) -> Result<Vec<u8>, ApiError> {
        let mut out = vec![];
        let mut total = 1;
        let mut i = 0;
        while i < total {
            let res = self.auth(self.http.get(self.url(&format!("/blobs/{id}/{i}")))).send().await.map_err(|e| ApiError::Network(e.to_string()))?;
            let status = res.status().as_u16();
            if status == 401 {
                return Err(ApiError::Unauthorized);
            }
            if status != 200 {
                return Err(ApiError::Server(status, "Couldn't download synced content".into()));
            }
            total = res.headers().get("x-chunks").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(1);
            out.extend(res.bytes().await.map_err(|e| ApiError::Network(e.to_string()))?);
            i += 1;
        }
        Ok(out)
    }

    pub async fn commit(&self, changes: &[Change]) -> Result<Vec<CommitResult>, ApiError> {
        let mut out = vec![];
        for batch in changes.chunks(200) {
            let r: CommitResponse = read(self.auth(self.http.post(self.url("/commit"))).json(&serde_json::json!({ "changes": batch })).send().await).await?;
            out.extend(r.results);
        }
        Ok(out)
    }

    pub async fn create_pairing(&self, lookup: &str, sealed: &str) -> Result<u64, ApiError> {
        #[derive(Deserialize)]
        struct R {
            expires: u64,
        }
        let r: R = read(self.auth(self.http.post(self.url("/pairings"))).json(&serde_json::json!({ "lookup": lookup, "sealed": sealed })).send().await).await?;
        Ok(r.expires)
    }

    pub async fn devices(&self) -> Result<Vec<Device>, ApiError> {
        #[derive(Deserialize)]
        struct R {
            devices: Vec<Device>,
        }
        Ok(read::<R>(self.auth(self.http.get(self.url("/devices"))).send().await).await?.devices)
    }

    pub async fn remove_device(&self, id: &str) -> Result<(), ApiError> {
        let _: serde_json::Value = read(self.auth(self.http.delete(self.url(&format!("/devices/{id}")))).send().await).await?;
        Ok(())
    }

    /// WebSocket URL and auth header for change notifications.
    pub fn ws_request(&self) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = self.url("/ws").replacen("http", "ws", 1);
        let mut req = url.into_client_request().map_err(|e| e.to_string())?;
        req.headers_mut().insert("authorization", format!("Bearer {}", self.token).parse().map_err(|_| "bad token")?);
        Ok(req)
    }
}
