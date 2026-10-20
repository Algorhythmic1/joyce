use serde::Serialize;
use std::time::Duration;

const MOBILE_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAX_HTML: usize = 2 * 1024 * 1024;

fn web_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only http and https website addresses are supported".into());
    }
    Ok(url)
}

#[derive(Serialize)]
pub struct WebsitePreview {
    url: String,
    html: String,
}

/// Fetch outside the app webview: mobile user agent, no app cookies or credentials.
#[tauri::command]
pub async fn website_preview(url: String) -> Result<WebsitePreview, String> {
    let url = web_url(&url)?;
    let client = reqwest::Client::builder()
        .user_agent(MOBILE_AGENT)
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || web_url(attempt.url().as_str()).is_err() {
                attempt.error("Unsupported website redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.starts_with("text/html") && !content_type.starts_with("application/xhtml+xml")
    {
        return Err("This address does not return a webpage".into());
    }
    let url = response.url().to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_HTML {
            return Err("This webpage is too large to preview".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(WebsitePreview {
        url,
        html: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[tauri::command]
pub fn website_open(url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    open::that_detached(url.as_str()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmarks_only_open_web_urls() {
        for url in [
            "https://example.com/path?q=1#part",
            "http://localhost:8080/",
        ] {
            assert!(web_url(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "https://user:secret@example.com",
            "example.com",
        ] {
            assert!(web_url(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn preview_requests_mobile_html_and_keeps_redirect_base() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for redirect in [true, false] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 8192];
                let n = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                assert!(request.contains(MOBILE_AGENT));
                let response = if redirect {
                    "HTTP/1.1 302 Found\r\nLocation: /mobile/page\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 15\r\nConnection: close\r\n\r\n<h1>Mobile</h1>"
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let preview = website_preview(format!("{origin}/")).await.unwrap();
        assert_eq!(preview.url, format!("{origin}/mobile/page"));
        assert_eq!(preview.html, "<h1>Mobile</h1>");
        server.join().unwrap();
    }
}
