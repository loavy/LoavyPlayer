//! Personal Spotify prototype. Tokens live only in the native process, never in SQLite.
use std::sync::{atomic::{AtomicU64, Ordering}, Arc};
use std::time::{Duration, Instant};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Method, Url};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::Mutex};

pub const REDIRECT_URI: &str = "http://127.0.0.1:43891/spotify/callback";
const SCOPES: &str = "user-read-private user-read-email playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state streaming";
#[derive(Clone)]
struct Session { client_id: String, access: String, refresh: String, expires: Instant }
#[derive(Default)]
struct Inner { session: Option<Session>, connecting: bool }
#[derive(Default)]
pub struct SpotifyState { inner: Mutex<Inner>, generation: AtomicU64, refresh_lock: Mutex<()> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { connected: bool, connecting: bool, redirect_uri: &'static str }

fn client() -> Result<Client, String> {
    Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Could not initialize Spotify networking.".into())
}
fn random_string() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Secure sign-in could not be initialized.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn valid_client_id(id: &str) -> bool { id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()) }
fn callback_code(target: &str, expected_state: &str) -> Result<Option<String>, String> {
    let url = Url::parse(&format!("http://127.0.0.1:43891{target}")).map_err(|_| "Invalid callback.".to_string())?;
    if url.path() != "/spotify/callback" { return Ok(None); }
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    if states.len() != 1 || states[0].1 != expected_state { return Ok(None); }
    if pairs.iter().any(|(key, _)| key == "error") { return Err("Spotify sign-in was declined. You can connect again whenever you like.".into()); }
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() { return Err("Spotify did not return an authorization code.".into()); }
    Ok(Some(codes[0].1.to_string()))
}
async fn receive_code(listener: TcpListener, state: &str, generation: u64, service: &SpotifyState) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if service.generation.load(Ordering::SeqCst) != generation { return Err("Spotify sign-in cancelled.".into()); }
        if Instant::now() >= deadline { return Err("Spotify sign-in timed out. Connect again to retry.".into()); }
        let accepted = tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
        let Ok(Ok((mut stream, _))) = accepted else { continue };
        let request = tokio::time::timeout(Duration::from_secs(2), async {
            let mut data = Vec::new(); let mut bytes = [0u8; 1024];
            while data.len() < 8192 {
                let count = stream.read(&mut bytes).await?;
                if count == 0 { break; } data.extend_from_slice(&bytes[..count]);
                if data.windows(4).any(|part| part == b"\r\n\r\n") { break; }
            }
            Ok::<_, std::io::Error>(data)
        }).await;
        let Ok(Ok(bytes)) = request else { continue };
        let request = String::from_utf8_lossy(&bytes);
        let mut line = request.lines().next().unwrap_or("").split_whitespace();
        let method = line.next().unwrap_or(""); let target = line.next().unwrap_or("");
        let result = if method == "GET" && target.starts_with('/') && !target.starts_with("//") { callback_code(target, state) } else { Ok(None) };
        let accepted = !matches!(result, Ok(None));
        let message = if accepted { "Spotify returned your sign-in. You can close this tab and return to Loavy Player." } else { "This sign-in request was not recognized. Return to the Spotify tab opened by Loavy." };
        let body = format!("<!doctype html><html><meta name=viewport content='width=device-width, initial-scale=1'><title>Loavy Player</title><body style='background:#101a1e;color:#e5eeef;font:18px system-ui;padding:10vh 10vw'><h1>Loavy Player</h1><p>{message}</p></body></html>");
        let response = format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{}", if accepted { "200 OK" } else { "400 Bad Request" }, body.len(), body);
        let _ = tokio::time::timeout(Duration::from_secs(2), stream.write_all(response.as_bytes())).await;
        match result { Ok(Some(code)) => return Ok(code), Err(message) => return Err(message), Ok(None) => {} }
    }
}
async fn token_exchange(form: &[(&str, &str)]) -> Result<Value, String> {
    let response = client()?.post("https://accounts.spotify.com/api/token").form(form).send().await.map_err(|_| "Could not reach Spotify sign-in. Check your connection.".to_string())?;
    if !response.status().is_success() { return Err("Spotify could not authorize this session. Check your Client ID and redirect URI, then connect again.".into()); }
    response.json().await.map_err(|_| "Spotify returned an invalid sign-in response.".into())
}
impl SpotifyState {
    async fn access_token(&self) -> Result<String, String> {
        let _refresh_guard = self.refresh_lock.lock().await;
        let session = self.inner.lock().await.session.clone().ok_or("Connect your Spotify account first.")?;
        if session.expires > Instant::now() + Duration::from_secs(60) { return Ok(session.access); }
        let generation = self.generation.load(Ordering::SeqCst);
        let value = token_exchange(&[("grant_type", "refresh_token"), ("refresh_token", &session.refresh), ("client_id", &session.client_id)]).await?;
        let access = value["access_token"].as_str().ok_or("Spotify session expired. Disconnect and connect again.")?.to_string();
        let refresh = value["refresh_token"].as_str().unwrap_or(&session.refresh).to_string();
        let mut inner = self.inner.lock().await;
        if self.generation.load(Ordering::SeqCst) != generation || inner.session.is_none() { return Err("Spotify disconnected.".into()); }
        inner.session = Some(Session { access: access.clone(), refresh, expires: Instant::now() + Duration::from_secs(value["expires_in"].as_u64().unwrap_or(3600)), ..session });
        Ok(access)
    }
}

#[tauri::command]
pub async fn spotify_status(service: State<'_, Arc<SpotifyState>>) -> Result<Status, String> {
    let inner = service.inner.lock().await;
    Ok(Status { connected: inner.session.is_some(), connecting: inner.connecting, redirect_uri: REDIRECT_URI })
}
#[tauri::command]
pub async fn spotify_connect(app: AppHandle, service: State<'_, Arc<SpotifyState>>, client_id: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if !valid_client_id(&client_id) { return Err("Enter the 32-character Client ID from your Spotify developer app. A Client Secret is not needed.".into()); }
    {
        let mut inner = service.inner.lock().await;
        if inner.connecting { return Err("A Spotify sign-in is already open. Finish or cancel it first.".into()); }
        inner.connecting = true;
    }
    let generation = service.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let result = async {
        let listener = TcpListener::bind("127.0.0.1:43891").await.map_err(|_| "Spotify sign-in port 43891 is in use. Close any other sign-in window and retry.".to_string())?;
        let verifier = random_string()?; let state = random_string()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = Url::parse("https://accounts.spotify.com/authorize").unwrap();
        url.query_pairs_mut().extend_pairs([("client_id", client_id.as_str()), ("response_type", "code"), ("redirect_uri", REDIRECT_URI), ("scope", SCOPES), ("state", &state), ("code_challenge_method", "S256"), ("code_challenge", &challenge)]);
        app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "Could not open your browser for Spotify sign-in.".to_string())?;
        let code = receive_code(listener, &state, generation, &service).await?;
        let value = token_exchange(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT_URI), ("client_id", &client_id), ("code_verifier", &verifier)]).await?;
        let access = value["access_token"].as_str().ok_or("Spotify did not return an access token.")?.to_string();
        let refresh = value["refresh_token"].as_str().ok_or("Spotify did not return a refresh token.")?.to_string();
        let mut inner = service.inner.lock().await;
        if service.generation.load(Ordering::SeqCst) != generation { return Err("Spotify sign-in cancelled.".into()); }
        inner.session = Some(Session { client_id, access, refresh, expires: Instant::now() + Duration::from_secs(value["expires_in"].as_u64().unwrap_or(3600)) });
        Ok(())
    }.await;
    service.inner.lock().await.connecting = false;
    result
}
#[tauri::command]
pub async fn spotify_disconnect(service: State<'_, Arc<SpotifyState>>) -> Result<(), String> {
    service.generation.fetch_add(1, Ordering::SeqCst);
    service.inner.lock().await.session = None;
    // Do not offer a new login until the cancelled listener/token exchange has
    // released its port and finished. The HTTP client already has a 20s timeout.
    let deadline = Instant::now() + Duration::from_secs(23);
    while service.inner.lock().await.connecting {
        if Instant::now() >= deadline { return Err("Spotify sign-in is still closing. Wait a moment before connecting again.".into()); }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}
#[tauri::command]
pub async fn spotify_sdk_token(service: State<'_, Arc<SpotifyState>>) -> Result<String, String> { service.access_token().await }

fn allowed_request(method: &str, path: &str) -> bool {
    if path.contains(['#', '\\']) || !path.starts_with('/') || path.starts_with("//") { return false; }
    let endpoint = path.split('?').next().unwrap_or("");
    if endpoint.contains('%') { return false; }
    match method {
        "GET" => matches!(endpoint, "/me" | "/me/playlists" | "/me/player" | "/me/player/devices" | "/search") || {
            let segments: Vec<_> = endpoint.split('/').collect();
            segments.len() == 4 && segments[1] == "playlists" && segments[2].len() == 22 && segments[2].bytes().all(|c| c.is_ascii_alphanumeric()) && segments[3] == "items"
        },
        "PUT" => matches!(endpoint, "/me/player" | "/me/player/play" | "/me/player/pause" | "/me/player/seek" | "/me/player/volume" | "/me/player/shuffle" | "/me/player/repeat"),
        "POST" => matches!(endpoint, "/me/player/next" | "/me/player/previous"),
        _ => false,
    }
}
#[tauri::command]
pub async fn spotify_request(service: State<'_, Arc<SpotifyState>>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !allowed_request(&method, &path) || path.len() > 4096 { return Err("Unsupported Spotify request.".into()); }
    let url = Url::parse(&format!("https://api.spotify.com/v1{path}")).map_err(|_| "Invalid Spotify request.".to_string())?;
    if url.host_str() != Some("api.spotify.com") || !url.path().starts_with("/v1/") { return Err("Invalid Spotify request.".into()); }
    let generation = service.generation.load(Ordering::SeqCst);
    for attempt in 0..2 {
        let token = service.access_token().await?;
        let mut request = client()?.request(Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid request method.")?, url.clone()).bearer_auth(token);
        if let Some(ref body) = body { request = request.json(body); }
        let response = request.send().await.map_err(|_| "Could not reach Spotify. Check your connection.".to_string())?;
        if service.generation.load(Ordering::SeqCst) != generation { return Err("Spotify disconnected.".into()); }
        let status = response.status().as_u16();
        if status == 401 && attempt == 0 {
            if let Some(ref mut session) = service.inner.lock().await.session { session.expires = Instant::now(); }
            continue;
        }
        if status == 204 { return Ok(Value::Null); }
        if status == 429 { let retry = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("a few"); return Err(format!("Spotify is busy. Try again in {retry} seconds.")); }
        if status == 403 { return Err("Spotify denied access. Playback needs Premium; development apps also require this account on their user allowlist. Playlist contents may be limited to playlists you own or collaborate on.".into()); }
        if status == 404 { return Err("No active Spotify device was found. Open Spotify, start a song, then refresh devices in Loavy.".into()); }
        if status == 401 { return Err("Spotify session expired. Disconnect and connect again.".into()); }
        if !(200..300).contains(&status) { return Err(format!("Spotify could not complete that request (HTTP {status}). Retry, or open the item in Spotify.")); }
        return response.json().await.map_err(|_| "Spotify returned an unreadable response.".into());
    }
    Ok(json!(null))
}
#[tauri::command]
pub fn spotify_open(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid Spotify link.".to_string())?;
    if parsed.scheme() != "https" || !matches!(parsed.host_str(), Some("open.spotify.com" | "developer.spotify.com" | "www.spotify.com")) || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() {
        return Err("Only official Spotify links can be opened here.".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|_| "Could not open Spotify in your browser.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callbacks_require_exact_state_and_path() {
        assert_eq!(callback_code("/spotify/callback?code=abc&state=right", "right").unwrap(), Some("abc".into()));
        for target in ["/spotify/callback?code=abc", "/spotify/callback?code=abc&state=wrong", "/other?code=abc&state=right", "/spotify/callback?code=abc&state=right&state=right"] { assert_eq!(callback_code(target, "right").unwrap(), None); }
        assert!(callback_code("/spotify/callback?error=access_denied&state=right", "right").is_err());
    }
    #[test]
    fn proxy_never_accepts_arbitrary_hosts_or_account_writes() {
        assert!(allowed_request("GET", "/me/playlists?limit=20&offset=0"));
        assert!(allowed_request("GET", "/search?q=late%20night&type=track&limit=10"));
        assert!(allowed_request("GET", "/playlists/1234567890123456789012/items?limit=50"));
        assert!(allowed_request("PUT", "/me/player/play?device_id=abc"));
        for endpoint in ["https://evil.test/me", "//evil.test/me", "/me/../evil", "/me#fragment", "/me%2f..", "/me\\evil"] { assert!(!allowed_request("GET", endpoint)); }
        assert!(!allowed_request("DELETE", "/me"));
        assert!(!allowed_request("PUT", "/me/playlists"));
    }
    #[tokio::test]
    async fn loopback_ignores_unrelated_requests_before_accepting_the_login() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let service = Arc::new(SpotifyState::default());
        let worker = tokio::spawn(async move { receive_code(listener, "expected", 0, &service).await });
        for (target, expected_status) in [("/spotify/callback?code=bad&state=wrong", "400 Bad Request"), ("/spotify/callback?code=accepted&state=expected", "200 OK")] {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response)).await.unwrap().unwrap();
            assert!(response.contains(expected_status));
            assert!(response.contains("Cache-Control: no-store"));
            assert!(!response.contains("code=accepted"));
        }
        assert_eq!(worker.await.unwrap().unwrap(), "accepted");
    }
    #[tokio::test]
    async fn cancelling_sign_in_closes_the_loopback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let service = Arc::new(SpotifyState::default());
        let worker_service = service.clone();
        let worker = tokio::spawn(async move { receive_code(listener, "expected", 0, &worker_service).await });
        service.generation.store(1, Ordering::SeqCst);
        let result = tokio::time::timeout(Duration::from_secs(2), worker).await.unwrap().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }
}
