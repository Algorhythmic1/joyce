//! GitHub integration. The access token lives in the macOS Keychain and is only
//! ever read here; the webview asks for API calls by path and never sees it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const KEYCHAIN_SERVICE: &str = "app.joyce.writer";
const KEYCHAIN_ACCOUNT: &str = "github";
const API: &str = "https://api.github.com";
const USER_AGENT: &str = "Joyce-Writer";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(err)
}

fn token() -> Result<Option<String>, String> {
    #[cfg(test)]
    if let Ok(t) = std::env::var("JOYCE_TEST_GITHUB_TOKEN") {
        return Ok(Some(t));
    }
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(USER_AGENT).build().map_err(err)
}

#[tauri::command]
pub fn github_signed_in() -> Result<bool, String> {
    Ok(token()?.is_some())
}

#[tauri::command]
pub fn github_sign_out() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Device flow (https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)

#[derive(Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[tauri::command]
pub async fn github_device_start(client_id: String) -> Result<DeviceCode, String> {
    let res = client()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": client_id, "scope": "repo" }))
        .send()
        .await
        .map_err(err)?;
    let body: Value = res.json().await.map_err(err)?;
    if let Some(e) = body.get("error") {
        let detail = body.get("error_description").and_then(Value::as_str).unwrap_or("");
        return Err(match e.as_str() {
            Some("device_flow_disabled") => "Device flow isn't enabled for this OAuth app. Turn on “Enable Device Flow” in its GitHub settings.".into(),
            Some("Not Found") | Some("incorrect_client_credentials") => "GitHub doesn't recognize that client ID.".into(),
            _ => format!("GitHub sign-in failed: {} {detail}", e.as_str().unwrap_or("unknown error")).trim().to_string(),
        });
    }
    serde_json::from_value(body).map_err(err)
}

/// Returns "pending", "slow_down" or "done". Errors mean the attempt is over.
#[tauri::command]
pub async fn github_device_poll(client_id: String, device_code: String) -> Result<String, String> {
    let res = client()?
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(err)?;
    let body: Value = res.json().await.map_err(err)?;
    if let Some(t) = body.get("access_token").and_then(Value::as_str) {
        entry()?.set_password(t).map_err(err)?;
        return Ok("done".into());
    }
    match body.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Ok("pending".into()),
        Some("slow_down") => Ok("slow_down".into()),
        Some("expired_token") => Err("The code expired. Start sign-in again.".into()),
        Some("access_denied") => Err("Sign-in was cancelled on GitHub.".into()),
        Some(e) => Err(format!("GitHub sign-in failed: {e}")),
        None => Err("Unexpected response from GitHub.".into()),
    }
}

/// Reuses the account the GitHub CLI is signed in to. Apps launched from Finder
/// don't get the shell's PATH, so look in the usual install locations.
#[tauri::command]
pub fn github_import_gh_cli() -> Result<(), String> {
    let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("The GitHub CLI (gh) isn't installed.")?;
    let out = std::process::Command::new(gh).args(["auth", "token"]).output().map_err(err)?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || t.is_empty() {
        return Err("The GitHub CLI isn't signed in. Run `gh auth login` first.".into());
    }
    entry()?.set_password(&t).map_err(err)
}

#[tauri::command]
pub fn github_gh_cli_available() -> bool {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .iter()
        .any(|p| std::path::Path::new(p).exists())
}

/// Opens a github.com page (the device-code page, a commit) in the default browser.
#[tauri::command]
pub fn github_open(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Only github.com links can be opened".into());
    }
    std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(err)
}

// --- REST API -------------------------------------------------------------

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    body: Value,
}

/// Authenticated call to api.github.com. Only reads and content writes (PUT) are
/// allowed, and only against the API host.
#[tauri::command]
pub async fn github_api(method: String, path: String, body: Option<Value>) -> Result<ApiResponse, String> {
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "PUT" => reqwest::Method::PUT,
        _ => return Err(format!("Method {method} is not allowed")),
    };
    if !path.starts_with('/') || path.contains("://") || path.contains("..") {
        return Err("Invalid API path".into());
    }
    let token = token()?.ok_or("Not signed in to GitHub.")?;
    let mut req = client()?
        .request(method, format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(err)?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(err)?;
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok(ApiResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_requests() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for (m, p) in [("DELETE", "/user"), ("GET", "https://evil.example/x"), ("GET", "/repos/../x")] {
            assert!(rt.block_on(github_api(m.into(), p.into(), None)).is_err(), "{m} {p}");
        }
    }

    #[test]
    #[ignore]
    fn device_flow_reports_bad_client_id() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let e = rt.block_on(github_device_start("not-a-real-client-id".into())).err().unwrap();
        println!("device flow error: {e}");
    }

    /// Read-only calls against the real repo. Run with
    /// `JOYCE_TEST_GITHUB_TOKEN=$(gh auth token) cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_live_repo() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let user = rt.block_on(github_api("GET".into(), "/user".into(), None)).unwrap();
        assert_eq!(user.status, 200);
        let file = rt
            .block_on(github_api(
                "GET".into(),
                "/repos/AlgorhythmicIndustries/bickerstaff-media-site/contents/src/content/blog/a-memecoin-story.mdx?ref=master".into(),
                None,
            ))
            .unwrap();
        assert_eq!(file.status, 200);
        assert!(file.body["sha"].is_string());
        let missing = rt
            .block_on(github_api(
                "GET".into(),
                "/repos/AlgorhythmicIndustries/bickerstaff-media-site/contents/src/content/blog/joyce-does-not-exist.mdx?ref=master".into(),
                None,
            ))
            .unwrap();
        assert_eq!(missing.status, 404);
    }
}
