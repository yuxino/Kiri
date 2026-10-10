//! WebKitGTK's media decoder accepts HTTP, but rejects custom `kiri` URIs.
//! A Linux-only loopback bridge serves video assets with an unguessable
//! process-scoped capability. No filesystem paths or general HTTP API exist.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tauri::Manager;

use crate::core::asset::CaptureKind;
use crate::protocol::{parse_media_range, MediaRangeDecision};
use crate::state::AppState;

const HEADER_LIMIT: usize = 8192;
const STREAM_BUFFER: usize = 64 * 1024;

pub struct MediaPlaybackServer {
    origin: String,
    authority: String,
    stopped: Arc<AtomicBool>,
}

impl MediaPlaybackServer {
    pub fn start(app: &tauri::AppHandle) -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .context("Could not prepare local video playback")?;
        let authority = listener.local_addr()?.to_string();
        let token = uuid::Uuid::new_v4().as_simple().to_string();
        let origin = format!("http://{authority}/{token}/media");
        let stopped = Arc::new(AtomicBool::new(false));
        // Fixed workers and a finite queue bound both open requests and memory.
        let (sender, receiver) = mpsc::sync_channel::<TcpStream>(16);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..4 {
            let receiver = receiver.clone();
            let app = app.clone();
            let authority = authority.clone();
            let token = token.clone();
            let stopped = stopped.clone();
            std::thread::Builder::new()
                .name(format!("kiri-video-http-{index}"))
                .spawn(move || {
                    while !stopped.load(Ordering::Acquire) {
                        let Ok(mut stream) = receiver.lock().unwrap().recv() else {
                            break;
                        };
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
                        // Errors deliberately do not log the capability URL.
                        let _ = serve_connection(&mut stream, &authority, &token, &stopped, |id| {
                            let state = app.state::<AppState>();
                            let mut context = state.library.lock().unwrap();
                            let Ok(library) = context.library() else {
                                return Ok(None);
                            };
                            let Some(asset) = library.asset_by_id(&id) else {
                                return Ok(None);
                            };
                            if asset.kind != CaptureKind::Video {
                                return Ok(None);
                            }
                            let Ok(path) = library.readable_asset_url(asset) else {
                                return Ok(None);
                            };
                            // Open under the library lock: a rename can remove
                            // the path while this request continues streaming.
                            open_playback_source(&path).map(Some)
                        });
                    }
                })?;
        }
        let stopped_listener = stopped.clone();
        std::thread::Builder::new()
            .name("kiri-video-http-listener".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    if stopped_listener.load(Ordering::Acquire) {
                        break;
                    }
                    // Drop overload rather than spawning unbounded request threads.
                    let _ = sender.try_send(stream);
                }
            })?;
        Ok(Self {
            origin,
            authority,
            stopped,
        })
    }

    pub fn stop(&self) {
        if !self.stopped.swap(true, Ordering::AcqRel) {
            // Wake accept; dropping its sender also releases waiting workers.
            let _ = TcpStream::connect(&self.authority);
        }
    }
}

impl Drop for MediaPlaybackServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub fn get_media_playback_origin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    if !matches!(window.label(), "library" | "toast") && !window.label().starts_with("viewer-") {
        return Err("This window does not play videos.".into());
    }
    #[cfg(target_os = "linux")]
    return Ok(Some(app.state::<MediaPlaybackServer>().origin.clone()));
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(None)
    }
}

struct PlaybackRequest {
    head: bool,
    id: uuid::Uuid,
    range: Option<String>,
    origin: Option<String>,
}

fn parse_request(bytes: &[u8], authority: &str, token: &str) -> Option<PlaybackRequest> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.strip_suffix("\r\n\r\n")?.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let method = request.next()?;
    let path = request.next()?;
    if !matches!(method, "GET" | "HEAD")
        || request.next()? != "HTTP/1.1"
        || request.next().is_some()
    {
        return None;
    }
    let id = path.strip_prefix(&format!("/{token}/media/"))?;
    // Only a canonical asset identifier. No path, query, encoded slash or file.
    let id = uuid::Uuid::parse_str(id)
        .ok()
        .filter(|value| value.to_string() == id)?;
    let mut host = None;
    let mut range = None;
    let mut origin = None;
    for line in lines {
        let (key, value) = line.split_once(':')?;
        let value = value.trim();
        if key.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() {
                return None;
            }
        } else if key.eq_ignore_ascii_case("range") {
            if range.replace(value.to_owned()).is_some() {
                return None;
            }
        } else if key.eq_ignore_ascii_case("origin") {
            if !matches!(
                value,
                "tauri://localhost" | "http://tauri.localhost" | "http://localhost:1420"
            ) || origin.replace(value.to_owned()).is_some()
            {
                return None;
            }
        } else if key.eq_ignore_ascii_case("content-length")
            || key.eq_ignore_ascii_case("transfer-encoding")
        {
            // Media reads never have a body; reject request-smuggling inputs.
            return None;
        }
    }
    if host != Some(authority) {
        return None;
    }
    Some(PlaybackRequest {
        head: method == "HEAD",
        id,
        range,
        origin,
    })
}

fn open_playback_source(path: &Path) -> Result<(std::fs::File, &'static str)> {
    let content_type = if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mov"))
    {
        "video/quicktime"
    } else {
        "video/mp4"
    };
    Ok((std::fs::File::open(path)?, content_type))
}

fn serve_connection(
    stream: &mut TcpStream,
    authority: &str,
    token: &str,
    stopped: &AtomicBool,
    resolve: impl FnOnce(uuid::Uuid) -> Result<Option<(std::fs::File, &'static str)>>,
) -> Result<()> {
    let mut header = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    let header_deadline = Instant::now() + Duration::from_secs(3);
    while header.len() < HEADER_LIMIT && !header.ends_with(b"\r\n\r\n") {
        if stopped.load(Ordering::Acquire) || Instant::now() >= header_deadline {
            return Ok(());
        }
        stream.read_exact(&mut byte)?;
        header.push(byte[0]);
    }
    let Some(request) = parse_request(&header, authority, token) else {
        stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    };
    let Some((mut file, content_type)) = resolve(request.id)? else {
        stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    };
    let total = file.metadata()?.len();
    let decision = parse_media_range(request.range.as_deref(), total);
    let (status, start, length, range_header) = match decision {
        MediaRangeDecision::Partial(range) => (
            "206 Partial Content",
            range.start,
            range.end - range.start + 1,
            format!(
                "Content-Range: bytes {}-{}/{total}\r\n",
                range.start, range.end
            ),
        ),
        MediaRangeDecision::Full if request.range.is_none() => ("200 OK", 0, total, String::new()),
        MediaRangeDecision::Full | MediaRangeDecision::Unsatisfiable => {
            write!(stream, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        }
    };
    let cors = request
        .origin
        .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"))
        .unwrap_or_default();
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\n{range_header}{cors}Accept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")?;
    if request.head {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = length;
    let mut buffer = [0u8; STREAM_BUFFER];
    let stream_deadline = Instant::now() + Duration::from_secs(60);
    while remaining > 0 {
        if stopped.load(Ordering::Acquire) || Instant::now() >= stream_deadline {
            return Ok(());
        }
        let limit = remaining.min(STREAM_BUFFER as u64) as usize;
        let count = file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Err(anyhow!("The video changed while it was playing."));
        }
        stream.write_all(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "b6e0347d999f466d9bc7db87d5c89f91";
    const ID: &str = "b6748b3f-4526-48b1-8730-f1684f6ef1cb";

    #[test]
    fn capability_routes_reject_unknown_hosts_methods_paths_and_bodies() {
        let valid = format!("GET /{TOKEN}/media/{ID} HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n");
        assert!(parse_request(valid.as_bytes(), "127.0.0.1:1234", TOKEN).is_some());
        for request in [
            valid.replace(TOKEN, "wrong"),
            valid.replace("GET", "POST"),
            valid.replace(ID, "../private.png"),
            valid.replace(ID, &format!("{ID}?path=x")),
            valid.replace("Host: 127.0.0.1:1234", "Host: evil.example"),
            valid.replace("\r\n\r\n", "\r\nContent-Length: 100\r\n\r\n"),
            valid.replace("\r\n\r\n", "\r\nHost: 127.0.0.1:1234\r\n\r\n"),
            valid.replace("\r\n\r\n", "\r\nOrigin: https://evil.example\r\n\r\n"),
        ] {
            assert!(parse_request(request.as_bytes(), "127.0.0.1:1234", TOKEN).is_none());
        }
    }

    fn response(extra: &str, method: &str) -> Vec<u8> {
        response_for_extension(extra, method, "mp4")
    }

    fn response_for_extension(extra: &str, method: &str, extension: &str) -> Vec<u8> {
        response_for_source_change(extra, method, extension, false)
    }

    fn response_for_source_change(
        extra: &str,
        method: &str,
        extension: &str,
        remove_source: bool,
    ) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(format!("video.{extension}"));
        std::fs::write(&path, b"0123456789").unwrap();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let mut client = TcpStream::connect(&authority).unwrap();
        write!(
            client,
            "{method} /{TOKEN}/media/{ID} HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n"
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            serve_connection(
                &mut stream,
                &authority,
                TOKEN,
                &AtomicBool::new(false),
                |_| {
                    let source = open_playback_source(&path)?;
                    if remove_source {
                        let renamed = path.with_file_name("renamed-video");
                        std::fs::rename(&path, &renamed)?;
                        std::fs::remove_file(&renamed)?;
                        assert!(!path.exists());
                        assert!(!renamed.exists());
                    }
                    Ok(Some(source))
                },
            )
            .unwrap();
        });
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        worker.join().unwrap();
        response
    }

    #[test]
    fn opened_playback_sources_survive_rename_and_removal() {
        for (extension, content_type) in [("mp4", "video/mp4"), ("mov", "video/quicktime")] {
            let range = response_for_source_change("Range: bytes=2-5\r\n", "GET", extension, true);
            assert!(range.starts_with(b"HTTP/1.1 206 Partial Content"));
            assert!(range.ends_with(b"2345"));
            let range = String::from_utf8(range).unwrap();
            assert!(range.contains("Content-Range: bytes 2-5/10\r\n"));
            assert!(range.contains(&format!("Content-Type: {content_type}\r\n")));
            let head = response_for_source_change("", "HEAD", extension, true);
            assert!(head.starts_with(b"HTTP/1.1 200 OK"));
            assert!(head.ends_with(b"\r\n\r\n"));
            let head = String::from_utf8(head).unwrap();
            assert!(head.contains("Content-Length: 10\r\n"));
            assert!(head.contains(&format!("Content-Type: {content_type}\r\n")));
        }
    }

    #[test]
    fn playback_content_type_matches_preserved_mov_and_mp4_containers() {
        for extension in ["mov", "MOV"] {
            for (extra, method) in [("", "GET"), ("", "HEAD"), ("Range: bytes=0-3\r\n", "GET")] {
                let bytes = response_for_extension(extra, method, extension);
                let response = String::from_utf8(bytes).unwrap();
                assert!(response.contains("Content-Type: video/quicktime\r\n"));
            }
        }
        assert!(String::from_utf8(response("", "GET"))
            .unwrap()
            .contains("Content-Type: video/mp4\r\n"));
    }

    #[test]
    fn playback_streams_get_head_suffix_ranges_and_unsatisfiable_ranges() {
        let full = response("", "GET");
        assert!(full.starts_with(b"HTTP/1.1 200 OK"));
        assert!(full.ends_with(b"0123456789"));
        let head = response("", "HEAD");
        assert!(head.ends_with(b"\r\n\r\n"));
        let range = response("Range: bytes=-3\r\n", "GET");
        assert!(range.starts_with(b"HTTP/1.1 206 Partial Content"));
        assert!(range.ends_with(b"789"));
        assert!(String::from_utf8(range)
            .unwrap()
            .contains("Content-Range: bytes 7-9/10"));
        let invalid = response("Range: bytes=20-\r\n", "GET");
        assert!(invalid.starts_with(b"HTTP/1.1 416 Range Not Satisfiable"));
        for extra in [
            "Range: bytes=5-4\r\n",
            "Range: items=0-2\r\n",
            "Range: bytes=0-1,4-5\r\n",
        ] {
            assert!(response(extra, "GET").starts_with(b"HTTP/1.1 416 Range Not Satisfiable"));
        }
    }
}
