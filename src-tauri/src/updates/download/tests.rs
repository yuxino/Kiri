use super::*;
use std::{
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

// Public verification example from minisign-verify 0.2.5; no private signing key.
fn fixture() -> (String, String) {
    let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
    (encode("untrusted comment: test public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"),
     encode("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ=="))
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: thread::JoinHandle<()>,
}

fn server(responses: Vec<&'static str>) -> Server {
    streaming_server(responses, None)
}

fn streaming_server(responses: Vec<&'static str>, chunk_delay: Option<Duration>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/package", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let task = thread::spawn(move || {
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    result => panic!("expected updater request: {result:?}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            received
                .lock()
                .unwrap()
                .push(String::from_utf8(request).unwrap().to_lowercase());
            if let Some(delay) = chunk_delay {
                let (headers, body) = response.split_once("\r\n\r\n").unwrap();
                write!(socket, "{headers}\r\n\r\n").unwrap();
                for byte in body.bytes() {
                    if socket.write_all(&[byte]).is_err() {
                        break;
                    }
                    socket.flush().unwrap();
                    thread::sleep(delay);
                }
            } else {
                socket.write_all(response.as_bytes()).unwrap();
            }
            socket.flush().unwrap();
            thread::sleep(Duration::from_millis(20));
        }
    });
    Server {
        url,
        requests,
        task,
    }
}

fn client() -> Client {
    client_builder()
        .https_only(false)
        .no_proxy()
        .read_timeout(Duration::from_secs(2))
        .retry(reqwest::retry::never())
        .build()
        .unwrap()
}
fn artifact<'a>(url: &'a str, signature: &'a str) -> Artifact<'a> {
    Artifact {
        version: "9.9.9",
        target: "test",
        url,
        signature,
    }
}

const INTERRUPTED: &str =
    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nETag: \"test-1\"\r\nConnection: close\r\n\r\nte";
const RESUMED: &str = "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 2-3/4\r\nConnection: close\r\n\r\nst";
const FULL: &str = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest";

#[tokio::test]
async fn interrupted_download_reopens_cache_and_requests_only_remaining_bytes() {
    let (key, signature) = fixture();
    let server = server(vec![INTERRUPTED, RESUMED]);
    let cache = tempfile::tempdir().unwrap();
    let artifact = artifact(&server.url, &signature);
    let failed = download(&client(), cache.path(), &artifact, &key, |_| {})
        .await
        .unwrap_err();
    assert_eq!(failed.downloaded, 2);
    assert_eq!(failed.total, Some(4));
    assert_eq!(fs::read(cache.path().join("package.part")).unwrap(), b"te");
    // No in-memory transport state survives; equivalent to restarting the app.
    let mut events = Vec::new();
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |event| events
            .push(event))
        .await
        .unwrap(),
        b"test"
    );
    assert!(matches!(
        events[0],
        DownloadEvent::Started {
            downloaded: 2,
            content_length: Some(4)
        }
    ));
    assert_eq!(
        events
            .iter()
            .filter_map(|event| match event {
                DownloadEvent::Progress { chunk_length } => Some(chunk_length),
                _ => None,
            })
            .sum::<usize>(),
        2
    );
    server.task.join().unwrap();
    {
        let requests = server.requests.lock().unwrap();
        assert!(!requests[0].contains("range:"));
        assert!(requests[1].contains("range: bytes=2-\r\n"));
        assert!(requests[1].contains("if-range: \"test-1\"\r\n"));
    }
    // A fully cached package is still verified, without another network request.
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap(),
        b"test"
    );
}

#[tokio::test]
async fn server_ignoring_range_replaces_prefix_instead_of_appending() {
    let (key, signature) = fixture();
    let server = server(vec![INTERRUPTED, FULL]);
    let cache = tempfile::tempdir().unwrap();
    let artifact = artifact(&server.url, &signature);
    assert!(download(&client(), cache.path(), &artifact, &key, |_| {})
        .await
        .is_err());
    let mut events = Vec::new();
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |event| events
            .push(event))
        .await
        .unwrap(),
        b"test"
    );
    assert!(events.iter().any(|event| matches!(
        event,
        DownloadEvent::Started {
            downloaded: 0,
            content_length: Some(4)
        }
    )));
    server.task.join().unwrap();
}

#[tokio::test]
async fn rejected_range_retries_once_without_range() {
    let (key, signature) = fixture();
    let server = server(vec![
        INTERRUPTED,
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        FULL,
    ]);
    let cache = tempfile::tempdir().unwrap();
    let artifact = artifact(&server.url, &signature);
    assert!(download(&client(), cache.path(), &artifact, &key, |_| {})
        .await
        .is_err());
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap(),
        b"test"
    );
    server.task.join().unwrap();
    assert!(!server.requests.lock().unwrap()[2].contains("range:"));
}

#[tokio::test]
async fn invalid_or_mismatched_ranges_discard_cache_without_offering_installation() {
    for response in [
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 1-2/4\r\nConnection: close\r\n\r\nst",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 2-3/5\r\nConnection: close\r\n\r\nst",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nConnection: close\r\n\r\nst",
    ] {
        let (key, signature) = fixture();
        let server = server(vec![INTERRUPTED, response]);
        let cache = tempfile::tempdir().unwrap();
        let artifact = artifact(&server.url, &signature);
        assert!(download(&client(), cache.path(), &artifact, &key, |_| {}).await.is_err());
        let failure = download(&client(), cache.path(), &artifact, &key, |_| {}).await.unwrap_err();
        assert_eq!(failure.downloaded, 0);
        server.task.join().unwrap();
    }
}

#[tokio::test]
async fn changed_artifact_never_uses_an_old_partial() {
    for changed_field in ["version", "target", "url", "signature"] {
        let (key, signature) = fixture();
        let server = server(vec![INTERRUPTED, FULL]);
        let cache = tempfile::tempdir().unwrap();
        let mut artifact = artifact(&server.url, &signature);
        let old_url = format!("{}?old", server.url);
        let old_signature = format!("{signature}\n");
        match changed_field {
            "version" => artifact.version = "9.9.8",
            "target" => artifact.target = "other",
            "url" => artifact.url = &old_url,
            "signature" => artifact.signature = &old_signature,
            _ => unreachable!(),
        }
        assert!(download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .is_err());
        assert_eq!(
            download(
                &client(),
                cache.path(),
                &super::tests::artifact(&server.url, &signature),
                &key,
                |_| {}
            )
            .await
            .unwrap(),
            b"test"
        );
        server.task.join().unwrap();
        assert!(!server.requests.lock().unwrap()[1].contains("range:"));
    }
}

#[tokio::test]
async fn unknown_length_is_indeterminate_and_verified_only_after_completion() {
    let (key, signature) = fixture();
    let server = server(vec!["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n"]);
    let cache = tempfile::tempdir().unwrap();
    let mut events = Vec::new();
    let artifact = artifact(&server.url, &signature);
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |event| events
            .push(event))
        .await
        .unwrap(),
        b"test"
    );
    assert!(events.iter().all(|event| !matches!(
        event,
        DownloadEvent::Started {
            content_length: Some(_),
            ..
        }
    )));
    server.task.join().unwrap();
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap(),
        b"test"
    );
}

#[tokio::test]
async fn signature_failure_discards_bad_bytes_and_allows_fresh_retry() {
    let (key, signature) = fixture();
    let server = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nevil",
        FULL,
    ]);
    let cache = tempfile::tempdir().unwrap();
    let artifact = artifact(&server.url, &signature);
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap_err()
            .downloaded,
        0
    );
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap(),
        b"test"
    );
    server.task.join().unwrap();
    assert!(!server.requests.lock().unwrap()[1].contains("range:"));
    // Also reject a fully cached payload changed after a successful download.
    fs::write(cache.path().join("package.part"), b"evil").unwrap();
    assert_eq!(
        download(&client(), cache.path(), &artifact, &key, |_| {})
            .await
            .unwrap_err()
            .downloaded,
        0
    );
}

#[tokio::test]
async fn oversized_response_is_rejected_before_buffering() {
    let (key, signature) = fixture();
    let server = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 9999999999\r\nConnection: close\r\n\r\n",
    ]);
    let cache = tempfile::tempdir().unwrap();
    assert_eq!(
        download(
            &client(),
            cache.path(),
            &artifact(&server.url, &signature),
            &key,
            |_| {}
        )
        .await
        .unwrap_err()
        .downloaded,
        0
    );
    server.task.join().unwrap();
}

#[test]
fn malformed_ranges_are_rejected() {
    for value in [
        "bytes */4",
        "bytes 2-1/4",
        "bytes 2-4/4",
        "bytes 0-0/0",
        "bytes 2-3/*",
        "items 2-3/4",
    ] {
        assert_eq!(parse_range(value), None);
    }
    assert_eq!(parse_range("bytes 2-3/4"), Some((2, 3, 4)));
}

#[tokio::test]
async fn slow_progress_can_outlast_the_read_timeout_but_a_stall_keeps_its_prefix() {
    for (delay, succeeds) in [(80, true), (400, false)] {
        let (key, signature) = fixture();
        let server = streaming_server(vec![FULL], Some(Duration::from_millis(delay)));
        let cache = tempfile::tempdir().unwrap();
        let client = client_builder()
            .https_only(false)
            .no_proxy()
            .read_timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let result = download(
            &client,
            cache.path(),
            &artifact(&server.url, &signature),
            &key,
            |_| {},
        )
        .await;
        if succeeds {
            assert_eq!(result.unwrap(), b"test");
        } else {
            assert_eq!(result.unwrap_err().downloaded, 1);
            assert_eq!(fs::read(cache.path().join("package.part")).unwrap(), b"t");
        }
        server.task.join().unwrap();
    }
}
