//! Linux media uses installed GStreamer libraries. No media helper process is
//! launched or downloaded. Every media pipeline is shut down on every exit path.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use gstreamer::prelude::*;
use gstreamer_pbutils::prelude::*;
use gstreamer_video::prelude::*;

use crate::capture::DisplayIdentity;
use crate::core::geometry::Rect;
use crate::core::policy::RecordingPolicy;
use crate::linux_audio::RecordingAudio;
use crate::record::{AudioChunkReceiver, EncoderConfig};

#[path = "linux_media_timing.rs"]
mod timing;
use timing::{queue_has_room, CaptureStartupGate, FrameTimeline};

const INPUT_POLL: Duration = Duration::from_millis(25);
const PORTAL_START_TIMEOUT: Duration = Duration::from_secs(120);
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(15);

/// GStreamer elements must reach NULL before their last reference is dropped,
/// including when a decode, push, EOS wait, or output validation fails.
struct PipelineGuard(gstreamer::Pipeline);

impl std::ops::Deref for PipelineGuard {
    type Target = gstreamer::Pipeline;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for PipelineGuard {
    fn drop(&mut self) {
        let _ = self.0.set_state(gstreamer::State::Null);
    }
}

fn pipeline(description: &str, operation: &str) -> Result<PipelineGuard> {
    gstreamer::init().context("GStreamer initialization failed")?;
    let element = gstreamer::parse::launch(description).with_context(|| {
        format!("Could not prepare {operation}; check the installed GStreamer plugins")
    })?;
    Ok(PipelineGuard(
        element
            .downcast::<gstreamer::Pipeline>()
            .map_err(|_| anyhow!("GStreamer did not return a pipeline for {operation}."))?,
    ))
}

fn set_file(pipeline: &gstreamer::Pipeline, element: &str, path: &Path) -> Result<()> {
    let path = path
        .to_str()
        .ok_or_else(|| anyhow!("The media path is not valid UTF-8."))?;
    pipeline
        .by_name(element)
        .ok_or_else(|| anyhow!("The media pipeline is missing {element}."))?
        .set_property("location", path);
    Ok(())
}

fn pipeline_bus(pipeline: &gstreamer::Pipeline) -> Result<gstreamer::Bus> {
    pipeline
        .bus()
        .ok_or_else(|| anyhow!("The media pipeline bus is missing."))
}

fn message_failure(message: &gstreamer::MessageRef, operation: &str) -> anyhow::Error {
    match message.view() {
        gstreamer::MessageView::Error(error) => anyhow!(
            "{operation} failed: {} ({})",
            error.error(),
            error.debug().as_deref().unwrap_or("no additional details")
        ),
        _ => anyhow!("{operation} ended unexpectedly."),
    }
}

fn check_pipeline(bus: &gstreamer::Bus, operation: &str) -> Result<()> {
    if let Some(message) =
        bus.pop_filtered(&[gstreamer::MessageType::Error, gstreamer::MessageType::Eos])
    {
        return Err(message_failure(&message, operation));
    }
    Ok(())
}

fn wait_for_eos(bus: &gstreamer::Bus, timeout: Duration, operation: &str) -> Result<()> {
    let message = bus
        .timed_pop_filtered(
            clock_time(timeout),
            &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
        )
        .ok_or_else(|| anyhow!("{operation} timed out before finalizing its output."))?;
    match message.view() {
        gstreamer::MessageView::Eos(_) => Ok(()),
        _ => Err(message_failure(&message, operation)),
    }
}

fn clock_time(duration: Duration) -> gstreamer::ClockTime {
    gstreamer::ClockTime::from_nseconds(duration.as_nanos().min(u128::from(u64::MAX - 1)) as u64)
}

fn staged_output(out_path: &Path) -> Result<tempfile::NamedTempFile> {
    tempfile::Builder::new()
        .prefix(".kiri-media-")
        .suffix(".mp4")
        .tempfile_in(out_path.parent().unwrap_or_else(|| Path::new(".")))
        .context("Could not create a temporary media output")
}

// ---------------------------------------------------------------------------
// ScreenCast / X11 → bounded BGRA frames
// ---------------------------------------------------------------------------

/// Keep the portal runtime alive for the whole stream, but never block it while
/// pumping frames. Each permission request is cancellable and shares one
/// deadline; stopping a recording cannot wait indefinitely for the chooser.
pub async fn run_pipewire_region_capture(
    display: DisplayIdentity,
    region: Rect,
    backing_scale: f64,
    shows_cursor: bool,
    video_tx: crate::capture::VideoFrameSender,
    stop_flag: Arc<AtomicBool>,
) -> Result<()> {
    if !crate::platform::linux::is_wayland_session() {
        return tokio::task::spawn_blocking(move || {
            run_x11_region_capture(
                display,
                region,
                backing_scale,
                shows_cursor,
                video_tx,
                stop_flag,
            )
        })
        .await
        .context("The X11 capture worker panicked")?;
    }

    let deadline = tokio::time::Instant::now() + PORTAL_START_TIMEOUT;
    let proxy = portal_step(
        &stop_flag,
        deadline,
        "connect to ScreenCast",
        Screencast::new(),
    )
    .await?;
    let session = portal_step(
        &stop_flag,
        deadline,
        "create ScreenCast session",
        proxy.create_session(),
    )
    .await?;
    let result = async {
        let cursor_mode = if shows_cursor {
            CursorMode::Embedded
        } else {
            CursorMode::Hidden
        };
        portal_step(
            &stop_flag,
            deadline,
            "select ScreenCast sources",
            proxy.select_sources(
                &session,
                cursor_mode,
                SourceType::Monitor.into(),
                false,
                None,
                PersistMode::DoNot,
            ),
        )
        .await?
        .response()
        .context("ScreenCast source selection was cancelled or denied")?;
        let response = portal_step(
            &stop_flag,
            deadline,
            "authorize ScreenCast",
            proxy.start(&session, None),
        )
        .await?
        .response()
        .context("ScreenCast was cancelled or denied")?;
        if response.streams().len() != 1 {
            bail!("Select exactly one display for Linux recording.");
        }
        let stream = &response.streams()[0];
        // Portal sizes/positions are compositor coordinates, not necessarily
        // physical pixels. The first PipeWire frame also validates pixel size.
        validate_portal_display(&display, stream.position(), stream.size())?;
        let node_id = stream.pipe_wire_node_id();
        let fd = portal_step(
            &stop_flag,
            deadline,
            "open the PipeWire stream",
            proxy.open_pipe_wire_remote(&session),
        )
        .await?;
        let stop_for_pump = Arc::clone(&stop_flag);
        tokio::task::spawn_blocking(move || {
            use std::os::fd::AsRawFd;
            let raw_fd = fd.as_raw_fd();
            let pipeline = pipeline(
                &format!(
                    "pipewiresrc fd={raw_fd} path={node_id} do-timestamp=true ! \
                 videoconvert ! video/x-raw,format=BGRA ! \
                 appsink name=sink max-buffers=2 drop=true sync=false"
                ),
                "PipeWire capture",
            )?;
            let crop = capture_crop(
                region,
                backing_scale,
                display.physical_width,
                display.physical_height,
            )?;
            let result = pump_capture_frames(
                pipeline,
                (display.physical_width, display.physical_height),
                crop,
                video_tx,
                stop_for_pump,
            );
            // The authorized remote must outlive every PipeWire element.
            drop(fd);
            result
        })
        .await
        .context("The PipeWire capture worker panicked")?
    }
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(2), session.close()).await;
    if stop_flag.load(Ordering::Acquire) {
        Ok(())
    } else {
        result
    }
}

async fn portal_step<T, E: std::fmt::Display>(
    stop: &AtomicBool,
    deadline: tokio::time::Instant,
    operation: &str,
    future: impl Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    tokio::select! {
        result = tokio::time::timeout_at(deadline, future) => {
            result
                .map_err(|_| anyhow!("Linux ScreenCast authorization timed out."))?
                .map_err(|error| anyhow!("Could not {operation}: {error}"))
        }
        _ = async {
            while !stop.load(Ordering::Acquire) {
                tokio::time::sleep(INPUT_POLL).await;
            }
        } => bail!("Linux ScreenCast was cancelled."),
    }
}

fn validate_portal_display(
    display: &DisplayIdentity,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
) -> Result<()> {
    let scale = display.scale_factor;
    if !scale.is_finite() || scale <= 0.0 {
        bail!("The selected display has an invalid scale.");
    }
    let matches = |actual: i32, expected: f64| (f64::from(actual) - expected).abs() <= 1.0;
    if size.is_some_and(|(width, height)| {
        !matches(width, f64::from(display.physical_width) / scale)
            || !matches(height, f64::from(display.physical_height) / scale)
    }) || position.is_some_and(|(x, y)| {
        !matches(x, f64::from(display.physical_x) / scale)
            || !matches(y, f64::from(display.physical_y) / scale)
    }) {
        bail!("The ScreenCast display does not match the screenshot. Select the same display and try again.");
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct PixelCrop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn capture_crop(region: Rect, scale: f64, full_width: u32, full_height: u32) -> Result<PixelCrop> {
    if ![region.x, region.y, region.width, region.height, scale]
        .iter()
        .all(|value| value.is_finite())
        || scale <= 0.0
        || region.x < 0.0
        || region.y < 0.0
        || region.width <= 0.0
        || region.height <= 0.0
    {
        bail!("The Linux recording region is invalid.");
    }
    let crop = PixelCrop {
        x: (region.x * scale).round() as u32,
        y: (region.y * scale).round() as u32,
        width: u32::try_from(RecordingPolicy::pixel_dimension(region.width, scale))?,
        height: u32::try_from(RecordingPolicy::pixel_dimension(region.height, scale))?,
    };
    if crop.width == 0
        || crop.height == 0
        || crop
            .x
            .checked_add(crop.width)
            .is_none_or(|end| end > full_width)
        || crop
            .y
            .checked_add(crop.height)
            .is_none_or(|end| end > full_height)
    {
        bail!("The recording region no longer fits the selected display.");
    }
    Ok(crop)
}

fn run_x11_region_capture(
    display: DisplayIdentity,
    region: Rect,
    backing_scale: f64,
    shows_cursor: bool,
    video_tx: crate::capture::VideoFrameSender,
    stop_flag: Arc<AtomicBool>,
) -> Result<()> {
    let crop = capture_crop(
        region,
        backing_scale,
        display.physical_width,
        display.physical_height,
    )?;
    let x = i64::from(display.physical_x) + i64::from(crop.x);
    let y = i64::from(display.physical_y) + i64::from(crop.y);
    if x < 0 || y < 0 {
        bail!("The X11 display has unsupported root-window coordinates.");
    }
    let end_x = x + i64::from(crop.width) - 1;
    let end_y = y + i64::from(crop.height) - 1;
    let fps = RecordingPolicy::FRAMES_PER_SECOND;
    let pipeline = pipeline(&format!(
        "ximagesrc use-damage=false show-pointer={shows_cursor} startx={x} starty={y} endx={end_x} endy={end_y} ! \
         video/x-raw,framerate={fps}/1 ! videoconvert ! video/x-raw,format=BGRA ! \
         appsink name=sink max-buffers=2 drop=true sync=false"
    ), "X11 capture")?;
    pump_capture_frames(
        pipeline,
        (crop.width, crop.height),
        PixelCrop { x: 0, y: 0, ..crop },
        video_tx,
        stop_flag,
    )
}

fn pump_capture_frames(
    pipeline: PipelineGuard,
    expected: (u32, u32),
    crop: PixelCrop,
    video_tx: crate::capture::VideoFrameSender,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let sink = pipeline
        .by_name("sink")
        .ok_or_else(|| anyhow!("The capture appsink is missing."))?
        .downcast::<gstreamer_app::AppSink>()
        .map_err(|_| anyhow!("The capture sink has the wrong type."))?;
    let bus = pipeline_bus(&pipeline)?;
    pipeline
        .set_state(gstreamer::State::Playing)
        .context("Could not start Linux screen capture")?;
    let mut first_frame_at = None::<Instant>;
    let mut startup_gate = CaptureStartupGate::new();
    let capture_started = Instant::now();
    let mut frame_schedule = FrameTimeline::new(RecordingPolicy::FRAMES_PER_SECOND);
    let first_frame_deadline = Instant::now() + Duration::from_secs(15);
    let mut dropped = 0u64;
    while !stop.load(Ordering::Acquire) {
        check_pipeline(&bus, "Linux screen capture")?;
        let Some(sample) = sink.try_pull_sample(clock_time(INPUT_POLL)) else {
            if sink.is_eos() {
                bail!("The screen sharing session ended unexpectedly.");
            }
            if first_frame_at.is_none() && Instant::now() >= first_frame_deadline {
                bail!("The screen sharing session did not deliver a video frame.");
            }
            continue;
        };
        let info = gstreamer_video::VideoInfo::from_caps(
            sample
                .caps()
                .ok_or_else(|| anyhow!("The capture frame has no format."))?,
        )?;
        if (info.width(), info.height()) != expected {
            bail!("The shared display size changed or differs from the screenshot; recording was stopped to avoid capturing the wrong region.");
        }
        let now = Instant::now();
        // Unmapping a GTK window and XSync do not wait for a compositor or an
        // uncovered application to repaint. Drain initial snapshots before
        // establishing the output clock, including resume and direct GIF.
        let source_time = sample
            .buffer()
            .and_then(|buffer| buffer.pts())
            .map(|pts| Duration::from_nanos(pts.nseconds()));
        if !startup_gate.accept(now.duration_since(capture_started), source_time) {
            continue;
        }
        if first_frame_at
            .is_some_and(|origin| frame_schedule.advance(now.duration_since(origin)).is_none())
        {
            continue;
        }
        let pixels = packed_sample_pixels(&sample, crop)?;
        match video_tx.try_send(pixels) {
            Ok(()) => {
                first_frame_at.get_or_insert(now);
            }
            Err(mpsc::TrySendError::Full(_)) => {
                dropped += 1;
                if dropped == 1 || dropped.is_multiple_of(120) {
                    log::warn!("Linux capture dropped {dropped} frames while the bounded encoder queue was full");
                }
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                bail!("The Linux video encoder stopped accepting frames.")
            }
        }
    }
    Ok(())
}

/// VideoMeta may specify a padded stride that cannot be inferred from total
/// buffer length. Map its packed RGBA/BGRA plane and copy only selected rows.
fn packed_sample_pixels(sample: &gstreamer::Sample, crop: PixelCrop) -> Result<Vec<u8>> {
    let caps = sample
        .caps()
        .ok_or_else(|| anyhow!("The video frame has no format."))?;
    let info = gstreamer_video::VideoInfo::from_caps(caps)?;
    if !matches!(
        info.format(),
        gstreamer_video::VideoFormat::Bgra | gstreamer_video::VideoFormat::Rgba
    ) {
        bail!("The video frame is not packed RGBA or BGRA.");
    }
    let buffer = sample
        .buffer()
        .ok_or_else(|| anyhow!("The video frame has no buffer."))?;
    let frame = gstreamer_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info)?;
    let stride = usize::try_from(frame.plane_stride()[0])
        .context("The video frame has a negative stride")?;
    crop_bgra_frame(
        frame.plane_data(0)?,
        stride,
        info.width(),
        info.height(),
        crop,
    )
    .ok_or_else(|| anyhow!("The video frame does not contain the selected region."))
}

fn crop_bgra_frame(
    source: &[u8],
    stride: usize,
    full_width: u32,
    full_height: u32,
    crop: PixelCrop,
) -> Option<Vec<u8>> {
    if crop.width == 0
        || crop.height == 0
        || crop.x.checked_add(crop.width)? > full_width
        || crop.y.checked_add(crop.height)? > full_height
        || stride < (full_width as usize).checked_mul(4)?
    {
        return None;
    }
    let row_bytes = (crop.width as usize).checked_mul(4)?;
    let mut out = vec![0u8; row_bytes.checked_mul(crop.height as usize)?];
    for row in 0..crop.height as usize {
        let offset = (crop.y as usize + row)
            .checked_mul(stride)?
            .checked_add((crop.x as usize).checked_mul(4)?)?;
        out[row * row_bytes..(row + 1) * row_bytes]
            .copy_from_slice(source.get(offset..offset.checked_add(row_bytes)?)?);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// GStreamer H.264 + optional mixed AAC → MP4 segment encoder
// ---------------------------------------------------------------------------

pub struct LinuxNativeSegmentEncoder {
    out_path: PathBuf,
    worker: Option<JoinHandle<Result<()>>>,
    shutdown: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    failure: Arc<std::sync::Mutex<Option<String>>>,
}

impl LinuxNativeSegmentEncoder {
    pub fn start(
        config: &EncoderConfig,
        out_path: PathBuf,
        video_rx: mpsc::Receiver<Vec<u8>>,
        system_audio_rx: Option<AudioChunkReceiver>,
        microphone_rx: Option<AudioChunkReceiver>,
    ) -> Result<Self> {
        // Linux native sources are part of the mux pipeline so they share its
        // clock. Cross-platform PCM hand-off channels must not be supplied.
        if system_audio_rx.is_some() || microphone_rx.is_some() {
            bail!("Linux audio must use the shared-clock capture pipeline.");
        }
        // Prepare synchronously: missing plugins or an unwritable destination
        // must fail before the UI announces a running recording.
        let prepared = PreparedEncoder::new(config, &out_path)?;
        Self::start_prepared(prepared, out_path, video_rx)
    }

    fn start_prepared(
        prepared: PreparedEncoder,
        out_path: PathBuf,
        video_rx: mpsc::Receiver<Vec<u8>>,
    ) -> Result<Self> {
        let shutdown = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_cancelled = Arc::clone(&cancelled);
        let output = out_path.clone();
        let failure = Arc::new(std::sync::Mutex::new(None));
        let worker_failure = failure.clone();
        let worker = std::thread::Builder::new()
            .name("kiri-linux-encoder".into())
            .spawn(move || {
                let result = encode_bgra_mp4(
                    prepared,
                    &output,
                    video_rx,
                    worker_shutdown,
                    worker_cancelled,
                );
                if let Err(error) = &result {
                    *worker_failure
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.to_string());
                }
                result
            })
            .context("Could not start the Linux encoder")?;
        Ok(Self {
            out_path,
            worker: Some(worker),
            shutdown,
            cancelled,
            failure,
        })
    }

    pub fn unexpected_failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn finish(mut self) -> Result<PathBuf> {
        self.shutdown.store(true, Ordering::Release);
        self.worker
            .take()
            .expect("encoder worker")
            .join()
            .map_err(|_| anyhow!("The Linux encoder worker panicked."))??;
        Ok(self.out_path.clone())
    }

    pub fn cancel(mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.shutdown.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            if matches!(worker.join(), Ok(Ok(()))) {
                let _ = std::fs::remove_file(&self.out_path);
            }
        }
    }
}

impl Drop for LinuxNativeSegmentEncoder {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.cancelled.store(true, Ordering::Release);
            self.shutdown.store(true, Ordering::Release);
            if matches!(worker.join(), Ok(Ok(()))) {
                let _ = std::fs::remove_file(&self.out_path);
            }
        }
    }
}

enum AudioSetup<'a> {
    Devices(&'a [crate::linux_audio::AudioSource]),
    #[cfg(test)]
    Tones(usize),
    #[cfg(test)]
    DelayedPcm,
}

impl AudioSetup<'_> {
    fn description(&self) -> String {
        match self {
            Self::Devices(sources) => RecordingAudio::description(sources.len(), "appsrc format=time is-live=true do-timestamp=false caps=audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"),
            #[cfg(test)]
            Self::Tones(count) => RecordingAudio::description(*count, "audiotestsrc is-live=true"),
            #[cfg(test)]
            Self::DelayedPcm => RecordingAudio::description(1, "appsrc format=time is-live=true do-timestamp=false caps=audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"),
        }
    }
    fn attach(&self, pipeline: &gstreamer::Pipeline) -> Result<RecordingAudio> {
        match self {
            Self::Devices(sources) => RecordingAudio::attach(pipeline, sources),
            #[cfg(test)]
            Self::Tones(count) => RecordingAudio::observe(pipeline, *count),
            #[cfg(test)]
            Self::DelayedPcm => RecordingAudio::observe(pipeline, 1),
        }
    }
}

struct PreparedEncoder {
    pipeline: PipelineGuard,
    appsrc: gstreamer_app::AppSrc,
    bus: gstreamer::Bus,
    output: tempfile::NamedTempFile,
    width: u32,
    height: u32,
    fps: u32,
    frame_bytes: usize,
    queue_bytes: u64,
    audio: RecordingAudio,
}

impl PreparedEncoder {
    fn new(config: &EncoderConfig, out_path: &Path) -> Result<Self> {
        let sources =
            crate::linux_audio::selected_sources(config.audio.is_some(), config.mic.is_some())?;
        Self::with_audio(config, out_path, AudioSetup::Devices(&sources))
    }

    fn with_audio(config: &EncoderConfig, out_path: &Path, setup: AudioSetup<'_>) -> Result<Self> {
        let width = u32::try_from(config.width).context("Invalid encoder width")?;
        let height = u32::try_from(config.height).context("Invalid encoder height")?;
        let bitrate = u32::try_from(config.bitrate).context("Invalid encoder bitrate")?;
        if width < 2
            || height < 2
            || width % 2 != 0
            || height % 2 != 0
            || !(1..=120).contains(&config.fps)
            || bitrate < 1000
        {
            bail!("Invalid Linux H.264 encoder configuration.");
        }
        let frame_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| anyhow!("The encoder frame dimensions overflow."))?;
        let queue_bytes = (frame_bytes as u64)
            .checked_mul(2)
            .ok_or_else(|| anyhow!("The encoder queue dimensions overflow."))?;
        let fps = config.fps;
        // x264enc already produces complete AVC access units and codec_data.
        // h264parse would clear their explicit duration in GstBaseParse and
        // replace it with 1/fps, truncating a static recording's final frame.
        let pipeline = pipeline(
            &format!(
                "appsrc name=src is-live=true format=time do-timestamp=false \
             caps=video/x-raw,format=BGRA,width={width},height={height},framerate={fps}/1 ! \
             videoconvert ! video/x-raw,format=I420 ! \
             x264enc tune=zerolatency speed-preset=superfast bitrate={} key-int-max={} ! \
             video/x-h264,profile=baseline,stream-format=avc,alignment=au ! mp4mux name=mux interleave-time=0 ! filesink name=output{}",
                bitrate / 1000,
                fps * 2,
                setup.description(),
            ),
            "H.264 MP4 encoding",
        )?;
        let output = staged_output(out_path)?;
        set_file(&pipeline, "output", output.path())?;
        let appsrc = pipeline
            .by_name("src")
            .ok_or_else(|| anyhow!("The encoder appsrc is missing."))?
            .downcast::<gstreamer_app::AppSrc>()
            .map_err(|_| anyhow!("The encoder source has the wrong type."))?;
        appsrc.set_block(false);
        appsrc.set_max_bytes(queue_bytes);
        let audio = setup.attach(&pipeline)?;
        if audio.is_enabled() {
            // libav AAC contributes 1024 priming samples. Preserve them as MP4
            // decode preroll rather than shifting audible content or its tail.
            pipeline
                .by_name("mux")
                .context("Missing MP4 mux")?
                .static_pad("audio_0")
                .context("Missing AAC mux pad")?
                .set_offset(-(1024 * 1_000_000_000i64 / 48_000));
        }
        pipeline.use_clock(Some(&gstreamer::SystemClock::obtain()));
        let bus = pipeline_bus(&pipeline)?;
        pipeline
            .set_state(gstreamer::State::Paused)
            .context("Could not prepare the Linux MP4 encoder")?;
        check_pipeline(&bus, "Linux MP4 encoding")?;
        Ok(Self {
            pipeline,
            appsrc,
            bus,
            output,
            width,
            height,
            fps,
            frame_bytes,
            queue_bytes,
            audio,
        })
    }

    fn has_room(&self) -> bool {
        // Only this worker pushes buffers; the streaming thread only removes
        // them. This preflight therefore enforces a hard two-frame bound even
        // on GStreamer versions where max-bytes is merely a notification.
        queue_has_room(
            self.appsrc.current_level_bytes(),
            self.frame_bytes as u64,
            self.queue_bytes,
        )
    }

    fn wait_for_room(&self) -> Result<()> {
        let deadline = Instant::now() + FINALIZE_TIMEOUT;
        while !self.has_room() {
            check_pipeline(&self.bus, "Linux MP4 encoding")?;
            if Instant::now() >= deadline {
                bail!("The Linux MP4 encoder stopped accepting frames.");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }

    fn push(&self, pixels: Vec<u8>, pts: Duration, duration: Duration) -> Result<()> {
        self.pipeline
            .set_state(gstreamer::State::Playing)
            .context("Could not start Linux media capture")?;
        let mut buffer = gstreamer::Buffer::from_mut_slice(pixels);
        let buffer_ref = buffer
            .get_mut()
            .ok_or_else(|| anyhow!("The encoder buffer is not writable."))?;
        buffer_ref.set_pts(clock_time(pts));
        buffer_ref.set_duration(clock_time(duration));
        self.appsrc
            .push_buffer(buffer)
            .context("The Linux encoder rejected a video frame")?;
        Ok(())
    }
}

fn encode_bgra_mp4(
    prepared: PreparedEncoder,
    out_path: &Path,
    video_rx: mpsc::Receiver<Vec<u8>>,
    shutdown: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    let mut native_audio = prepared.audio.prepare_native()?;
    let mut pending = None::<Vec<u8>>;
    let mut origin = None::<Instant>;
    let mut timeline = FrameTimeline::new(prepared.fps);
    loop {
        if cancelled.load(Ordering::Acquire) {
            bail!("Linux recording was cancelled.");
        }
        check_pipeline(&prepared.bus, "Linux MP4 encoding")?;
        if let (Some(start), Some(capture)) = (origin, &mut native_audio) {
            capture.pump(start, None, |index, bytes, pts, duration| {
                prepared.audio.push(index, bytes, pts, duration)
            })?;
        }
        let mut frame = if shutdown.load(Ordering::Acquire) {
            match video_rx.try_recv() {
                Ok(frame) => frame,
                Err(_) => break,
            }
        } else {
            match video_rx.recv_timeout(INPUT_POLL) {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if prepared.audio.is_enabled() {
                        if let (Some(start), Some(pixels)) = (origin, pending.as_ref()) {
                            prepared.audio.check(start)?;
                            if prepared.has_room() {
                                if let Some((pts, duration)) = timeline.advance(start.elapsed()) {
                                    prepared.push(pixels.clone(), pts, duration)?;
                                }
                            }
                        }
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        };
        if frame.len() != prepared.frame_bytes {
            bail!("The Linux capture frame size changed during recording.");
        }
        if origin.is_none() {
            if let Some(capture) = &mut native_audio {
                capture.start_for_recording(&cancelled)?;
                // Discard at most the bounded capture backlog, then prefer a
                // fresh frame after audio preparation. Static/test producers
                // may have no new frame, so this wait is only one frame long.
                for _ in 0..crate::capture::VIDEO_FRAME_QUEUE_CAPACITY {
                    match video_rx.try_recv() {
                        Ok(latest) => frame = latest,
                        Err(_) => break,
                    }
                }
                if !shutdown.load(Ordering::Acquire) {
                    if let Ok(latest) = video_rx.recv_timeout(Duration::from_nanos(
                        1_000_000_000 / u64::from(prepared.fps),
                    )) {
                        frame = latest;
                    }
                }
                if frame.len() != prepared.frame_bytes {
                    bail!("The Linux capture frame size changed during recording.");
                }
            }
            prepared
                .pipeline
                .set_state(gstreamer::State::Playing)
                .context("Could not start Linux media capture")?;
            origin = Some(Instant::now());
        }
        let start = origin.expect("recording clock");
        prepared.audio.check(start)?;
        if pending.is_none() {
            pending = Some(frame);
            continue;
        }
        if !prepared.has_room() {
            continue;
        }
        if let Some((pts, duration)) = timeline.advance(start.elapsed()) {
            prepared.push(
                pending.replace(frame).expect("pending video frame"),
                pts,
                duration,
            )?;
        }
    }
    let start = origin.ok_or_else(|| anyhow!("The Linux recorder produced no video frames."))?;
    // Capture stop closes the source before finish; measure this boundary
    // before flushing so mux/encoder latency never extends the recording.
    let (pts, duration) = timeline.finish(start.elapsed());
    if let Some(capture) = &mut native_audio {
        capture.finish(start, pts + duration, |index, bytes, pts, duration| {
            prepared.audio.push(index, bytes, pts, duration)
        })?;
    }
    drop(native_audio);
    prepared.audio.finish()?;
    prepared.wait_for_room()?;
    prepared.push(pending.expect("first video frame"), pts, duration)?;
    prepared
        .appsrc
        .end_of_stream()
        .context("Could not finish the Linux encoder input")?;
    wait_for_eos(&prepared.bus, FINALIZE_TIMEOUT, "Linux MP4 encoding")?;
    prepared.audio.validate()?;
    let PreparedEncoder {
        pipeline,
        output,
        width,
        height,
        audio,
        ..
    } = prepared;
    let has_audio = audio.is_enabled();
    drop(pipeline);
    validate_recording_tracks(output.path(), Some((width, height)), Some(has_audio))?;
    if cancelled.load(Ordering::Acquire) {
        bail!("Linux recording was cancelled.");
    }
    output
        .persist_noclobber(out_path)
        .map_err(|error| anyhow!("Could not publish the finished recording: {}", error.error))?;
    Ok(())
}

pub fn probe_video(video: &Path) -> Option<(i64, i64, Option<f64>)> {
    let info = discover(video).ok()?;
    let streams = info.video_streams();
    let stream = streams.first()?;
    let orientation = stream.tags().and_then(|tags| {
        tags.get::<gstreamer::tags::ImageOrientation>()
            .map(|value| value.get().to_owned())
    });
    let (width, height) =
        display_dimensions(stream.width(), stream.height(), orientation.as_deref());
    Some((
        i64::from(width),
        i64::from(height),
        info.duration()
            .map(|time| time.nseconds() as f64 / 1_000_000_000.0),
    ))
}

fn display_dimensions(width: u32, height: u32, orientation: Option<&str>) -> (u32, u32) {
    if matches!(
        orientation,
        Some("rotate-90" | "rotate-270" | "flip-rotate-90" | "flip-rotate-270")
    ) {
        (height, width)
    } else {
        (width, height)
    }
}

fn discover(video: &Path) -> Result<gstreamer_pbutils::DiscovererInfo> {
    gstreamer::init()?;
    let discoverer = gstreamer_pbutils::Discoverer::new(gstreamer::ClockTime::from_seconds(5))?;
    let uri = glib::filename_to_uri(video, None)?;
    let info = discoverer.discover_uri(&uri)?;
    if info.result() != gstreamer_pbutils::DiscovererResult::Ok {
        bail!("The media file could not be completely inspected.");
    }
    Ok(info)
}

fn validate_recording(video: &Path, expected: Option<(u32, u32)>) -> Result<(u32, u32, f64)> {
    validate_recording_tracks(video, expected, None)
}

fn validate_recording_tracks(
    video: &Path,
    expected: Option<(u32, u32)>,
    expected_audio: Option<bool>,
) -> Result<(u32, u32, f64)> {
    use std::io::Read;
    let mut header = [0; 12];
    std::fs::File::open(video)?.read_exact(&mut header)?;
    if &header[4..8] != b"ftyp" {
        bail!("The recording is not an MP4 container.");
    }
    let info = discover(video)?;
    let streams = info.video_streams();
    let audio = info.audio_streams();
    if streams.len() != 1
        || audio.len() > 1
        || expected_audio.is_some_and(|expected| expected != !audio.is_empty())
    {
        bail!("The Linux recording contains unexpected media tracks.");
    }
    if let Some(audio) = audio.first() {
        if audio.sample_rate() != 48_000
            || audio.channels() != 2
            || !audio.caps().is_some_and(|caps| {
                caps.structure(0).is_some_and(|structure| {
                    structure.name() == "audio/mpeg"
                        && structure.get::<i32>("mpegversion").ok() == Some(4)
                })
            })
        {
            bail!("The finalized recording has an invalid AAC audio track.");
        }
    }
    let stream = &streams[0];
    let dimensions = (stream.width(), stream.height());
    if dimensions.0 == 0 || dimensions.1 == 0 || expected.is_some_and(|size| size != dimensions) {
        bail!("The finalized recording has invalid dimensions.");
    }
    let duration = info
        .duration()
        .filter(|value| *value > gstreamer::ClockTime::ZERO)
        .ok_or_else(|| anyhow!("The finalized MP4 has no positive duration."))?;
    Ok((
        dimensions.0,
        dimensions.1,
        duration.nseconds() as f64 / 1_000_000_000.0,
    ))
}

pub fn merge_segments(segments: &[PathBuf], out_path: &Path) -> Result<()> {
    if segments.is_empty() {
        bail!("No recording segments to merge.");
    }
    let first = validate_recording(&segments[0], None)?;
    let has_audio = !discover(&segments[0])?.audio_streams().is_empty();
    let mut durations = vec![Duration::from_secs_f64(first.2)];
    let mut expected_duration = first.2;
    for segment in &segments[1..] {
        let duration =
            validate_recording_tracks(segment, Some((first.0, first.1)), Some(has_audio))?.2;
        expected_duration += duration;
        durations.push(Duration::from_secs_f64(duration));
    }
    let output = staged_output(out_path)?;
    if segments.len() == 1 {
        std::fs::copy(&segments[0], output.path()).context("Could not stage the recording")?;
    } else {
        // qtdemux already supplies AVC access units, codec_data and exact MP4
        // sample durations. Preserve these through concat, including the last
        // held frame; another h264parse would replace its duration with 1/fps.
        // concat adjusts segment running times before the fresh MP4 container.
        let mut description = String::from(
            "concat name=c adjust-base=true ! identity single-segment=true ! video/x-h264,stream-format=avc,alignment=au ! mp4mux name=mux interleave-time=0 ! filesink name=output"
        );
        if has_audio {
            description = description.replace(
                "concat name=c adjust-base=true",
                "concat name=c adjust-base=false",
            );
            description.push_str(" concat name=ac adjust-base=false ! identity single-segment=true ! audiorate ! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ! avenc_aac bitrate=192000 ! aacparse ! queue max-size-buffers=0 max-size-bytes=262144 max-size-time=0 ! mux.audio_0");
        }
        for index in 0..segments.len() {
            description.push_str(&format!(
                " filesrc name=input_{index} ! qtdemux name=demux_{index} demux_{index}.video_0 ! video/x-h264,stream-format=avc,alignment=au ! queue name=video_merge_{index} max-size-buffers=2 max-size-bytes=0 max-size-time=0 ! c.sink_{index}"
            ));
            if has_audio {
                description.push_str(&format!(" demux_{index}.audio_0 ! decodebin ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ! queue name=audio_merge_{index} max-size-buffers=0 max-size-bytes=96000 max-size-time=0 ! ac.sink_{index}"));
            }
        }
        let pipeline = pipeline(&description, "recording segment merge")?;
        if has_audio {
            pipeline
                .by_name("mux")
                .context("Missing MP4 mux")?
                .static_pad("audio_0")
                .context("Missing AAC mux pad")?
                .set_offset(-(1024 * 1_000_000_000i64 / 48_000));
        }
        set_file(&pipeline, "output", output.path())?;
        for (index, segment) in segments.iter().enumerate() {
            set_file(&pipeline, &format!("input_{index}"), segment)?;
            if has_audio {
                // Both streams use the same container presentation boundary.
                // Either AAC rounding or the held video frame can be longer;
                // normalizing only one concat would accumulate skew at pauses.
                let duration = clock_time(durations[index]);
                let base = clock_time(durations[..index].iter().copied().sum());
                for name in [
                    format!("audio_merge_{index}"),
                    format!("video_merge_{index}"),
                ] {
                    pipeline
                        .by_name(&name)
                        .context("Missing merge queue")?
                        .static_pad("src")
                        .context("Missing merge pad")?
                        .add_probe(gstreamer::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
                            if let Some(event) = info.event_mut() {
                                if let gstreamer::EventView::Segment(segment_event) = event.view() {
                                    if let Some(segment) = segment_event
                                        .segment()
                                        .downcast_ref::<gstreamer::ClockTime>()
                                    {
                                        let mut segment = segment.clone();
                                        segment.set_base(base);
                                        segment.set_stop(
                                            segment.start().unwrap_or(gstreamer::ClockTime::ZERO)
                                                + duration,
                                        );
                                        *event = gstreamer::event::Segment::builder(&segment)
                                            .seqnum(event.seqnum())
                                            .build();
                                    }
                                }
                            }
                            gstreamer::PadProbeReturn::Ok
                        });
                }
            }
        }
        let bus = pipeline_bus(&pipeline)?;
        pipeline
            .set_state(gstreamer::State::Playing)
            .context("Could not start recording segment merge")?;
        wait_for_eos(&bus, Duration::from_secs(120), "Recording segment merge")?;
        drop(pipeline);
    }
    let actual =
        validate_recording_tracks(output.path(), Some((first.0, first.1)), Some(has_audio))?;
    if (actual.2 - expected_duration).abs() > 0.1 {
        bail!("The merged recording duration does not match its completed segments.");
    }
    output
        .persist_noclobber(out_path)
        .map_err(|error| anyhow!("Could not publish the merged recording: {}", error.error))?;
    Ok(())
}

fn decode_pipeline(
    video: &Path,
    width: u32,
    height: u32,
    fps: Option<u32>,
) -> Result<(PipelineGuard, gstreamer_app::AppSink)> {
    let rate = fps
        .map(|fps| format!("videorate ! video/x-raw,framerate={fps}/1 ! "))
        .unwrap_or_default();
    let pipeline = pipeline(
        &format!(
            "filesrc name=input ! decodebin ! videoconvert ! videoflip video-direction=auto ! videoscale ! \
         video/x-raw,format=RGBA,width={width},height={height} ! {rate}\
         appsink name=sink max-buffers=1 drop=false sync=false"
        ),
        "video decoding",
    )?;
    set_file(&pipeline, "input", video)?;
    let sink = pipeline
        .by_name("sink")
        .ok_or_else(|| anyhow!("The decoder appsink is missing."))?
        .downcast::<gstreamer_app::AppSink>()
        .map_err(|_| anyhow!("The decoder sink has the wrong type."))?;
    pipeline
        .set_state(gstreamer::State::Playing)
        .context("Could not start video decoding")?;
    Ok((pipeline, sink))
}

pub fn video_first_frame_png(video: &Path, max_long_edge: u32) -> Result<Vec<u8>> {
    let (width, height, _) =
        probe_video(video).ok_or_else(|| anyhow!("Could not inspect the video."))?;
    let (width, height) =
        scale_long_edge(u32::try_from(width)?, u32::try_from(height)?, max_long_edge);
    let (pipeline, sink) = decode_pipeline(video, width, height, None)?;
    let sample = match sink.try_pull_sample(gstreamer::ClockTime::from_seconds(10)) {
        Some(sample) => sample,
        None => {
            check_pipeline(&pipeline_bus(&pipeline)?, "Thumbnail decoding")?;
            bail!("No thumbnail frame was decoded.");
        }
    };
    let pixels = packed_sample_pixels(
        &sample,
        PixelCrop {
            x: 0,
            y: 0,
            width,
            height,
        },
    )?;
    drop(pipeline);
    let rgba = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or_else(|| anyhow!("The thumbnail pixel buffer size is invalid."))?;
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba).write_to(&mut encoded, image::ImageFormat::Png)?;
    Ok(encoded.into_inner())
}

pub fn export_gif(
    video: &Path,
    max_long_edge: u32,
    fps: u32,
) -> Result<(PathBuf, i64, i64, Option<f64>)> {
    export_gif_controlled(video, max_long_edge, fps, &crate::gif::GifControl::default(), &mut |_, _| {})
}

pub fn export_gif_controlled(video: &Path, max_long_edge: u32, fps: u32,
    control: &crate::gif::GifControl, progress: crate::gif::GifProgress<'_>,
) -> Result<(PathBuf, i64, i64, Option<f64>)> {
    control.check()?;
    let mut clock = crate::core::gif_timing::GifFrameClock::new(fps)
        .ok_or_else(|| anyhow!("The GIF frame rate is invalid."))?;
    let (width, height, duration) =
        probe_video(video).ok_or_else(|| anyhow!("Could not inspect the source video."))?;
    let _duration = duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| anyhow!("The source video has no positive duration."))?;
    let (width, height) =
        scale_long_edge(u32::try_from(width)?, u32::try_from(height)?, max_long_edge);
    progress("checking", Some(0.0));
    {
        let (pipeline, sink) = decode_pipeline(video, width, height, Some(fps))?;
        let bus = pipeline_bus(&pipeline)?;
        let mut count = 0;
        let mut last_frame = std::time::Instant::now();
        while let Some(sample) = pull_gif_sample(&sink, &bus, control, &mut last_frame)? {
            packed_sample_pixels(&sample, PixelCrop { x: 0, y: 0, width, height })?;
            count += 1;
            progress("checking", Some((count as f64 / (_duration * fps as f64)).min(1.0)));
        }
        if count == 0 { bail!("GIF decoding produced no frames."); }
    }
    control.check()?;
    progress("encoding", Some(0.0));
    let out_path = std::env::temp_dir().join(format!(
        "kiri-linux-gif-{}.gif",
        uuid::Uuid::new_v4().as_simple()
    ));
    let output = tempfile::Builder::new()
        .prefix(".kiri-gif-")
        .suffix(".gif")
        .tempfile()?;
    let (pipeline, sink) = decode_pipeline(video, width, height, Some(fps))?;
    let bus = pipeline_bus(&pipeline)?;
    let mut frame_count = 0usize;
    {
        let mut writer = std::io::BufWriter::new(output.reopen()?);
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut writer, 10);
        encoder.set_repeat(image::codecs::gif::Repeat::Infinite)?;
        let mut last_frame = std::time::Instant::now();
        loop {
            // A bounded appsink plus one encoded frame keeps memory independent
            // of recording length. No optional external gifenc plugin is needed.
            let Some(sample) = pull_gif_sample(&sink, &bus, control, &mut last_frame)? else { break; };
            let pixels = packed_sample_pixels(
                &sample,
                PixelCrop {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
            )?;
            let rgba = image::RgbaImage::from_raw(width, height, pixels)
                .ok_or_else(|| anyhow!("The GIF frame size is invalid."))?;
            encoder.encode_frame(image::Frame::from_parts(
                rgba,
                0,
                0,
                image::Delay::from_numer_denom_ms(clock.next_delay_ms(), 1),
            ))?;
            frame_count += 1;
            progress("encoding", Some((frame_count as f64 / (_duration * fps as f64)).min(1.0)));
        }
        control.check()?;
        progress("finalizing", Some(1.0));
        drop(encoder);
        std::io::Write::flush(&mut writer)?;
    }
    drop(pipeline);
    if frame_count == 0 {
        bail!("GIF encoding produced no frames.");
    }
    output
        .persist_noclobber(&out_path)
        .map_err(|error| anyhow!("Could not publish the GIF: {}", error.error))?;
    Ok((
        out_path,
        i64::from(width),
        i64::from(height),
        Some(clock.duration_seconds()),
    ))
}

fn pull_gif_sample(sink: &gstreamer_app::AppSink, bus: &gstreamer::Bus,
    control: &crate::gif::GifControl, last_frame: &mut std::time::Instant,
) -> Result<Option<gstreamer::Sample>> {
    loop {
        control.check()?;
        if let Some(message) = bus.pop_filtered(&[gstreamer::MessageType::Error]) {
            return Err(message_failure(&message, "GIF decoding"));
        }
        if let Some(sample) = sink.try_pull_sample(gstreamer::ClockTime::from_mseconds(100)) {
            control.check()?;
            *last_frame = std::time::Instant::now();
            return Ok(Some(sample));
        }
        if sink.is_eos() { return Ok(None); }
        if last_frame.elapsed() >= std::time::Duration::from_secs(15) {
            bail!("GIF decoding stopped delivering video frames.");
        }
    }
}

fn scale_long_edge(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    if width == 0 || height == 0 || max_long_edge == 0 {
        return (1, 1);
    }
    if width.max(height) <= max_long_edge {
        return (width, height);
    }
    if width >= height {
        (
            max_long_edge,
            (u64::from(height) * u64::from(max_long_edge) / u64::from(width)).max(1) as u32,
        )
    } else {
        (
            (u64::from(width) * u64::from(max_long_edge) / u64::from(height)).max(1) as u32,
            max_long_edge,
        )
    }
}

// Share only generated recording-pipeline inputs with the export integration tests.
#[cfg(test)]
pub(crate) fn recording_audio_fixture(path: &Path, frequencies: &[f64], millis: u64) -> f64 {
    tests::audio_fixture(path, frequencies, millis);
    validate_recording_tracks(path, Some((64, 48)), Some(true)).unwrap().2
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::AnimationDecoder;

    #[test]
    fn display_dimensions_apply_all_rotated_orientation_tags() {
        for orientation in [
            "rotate-90",
            "rotate-270",
            "flip-rotate-90",
            "flip-rotate-270",
        ] {
            assert_eq!(display_dimensions(320, 200, Some(orientation)), (200, 320));
        }
        for orientation in [
            None,
            Some("rotate-0"),
            Some("rotate-180"),
            Some("flip-rotate-0"),
            Some("unknown"),
        ] {
            assert_eq!(display_dimensions(320, 200, orientation), (320, 200));
        }
    }

    #[test]
    fn native_rotation_metadata_changes_thumbnail_and_gif_display_orientation() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "rotation");
        let original = temp.path().join("original.mp4");
        let rotated = temp.path().join("rotated.mp4");
        let encoder = PreparedEncoder::new(&config(), &original).unwrap();
        let mut pixels = solid_frame([0, 0, 255, 255]);
        for y in 24..48 {
            for x in 0..64 {
                pixels[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        encoder
            .push(pixels, Duration::ZERO, Duration::from_secs(1))
            .unwrap();
        encoder.appsrc.end_of_stream().unwrap();
        wait_for_eos(&encoder.bus, FINALIZE_TIMEOUT, "Rotation fixture encoding").unwrap();
        let PreparedEncoder {
            pipeline, output, ..
        } = encoder;
        drop(pipeline);
        output.persist_noclobber(&original).unwrap();

        // Write the standard quarter-turn track-header display matrix directly;
        // keep compressed samples identical without a media helper executable.
        let mut bytes = std::fs::read(&original).unwrap();
        let tkhd = bytes.windows(4).position(|part| part == b"tkhd").unwrap();
        let payload = tkhd + 4;
        let matrix = payload + if bytes[payload] == 1 { 52 } else { 40 };
        for (index, value) in [0i32, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30]
            .into_iter()
            .enumerate()
        {
            bytes[matrix + index * 4..matrix + index * 4 + 4].copy_from_slice(&value.to_be_bytes());
        }
        std::fs::write(&rotated, bytes).unwrap();
        assert_eq!(probe_video(&original).unwrap().0, 64);
        let metadata = probe_video(&rotated).unwrap();
        assert_eq!((metadata.0, metadata.1), (48, 64));
        let thumbnail = video_first_frame_png(&rotated, 64).unwrap();
        std::fs::write(temp.path().join("rotated-first-frame.png"), &thumbnail).unwrap();
        let thumbnail = image::load_from_memory(&thumbnail).unwrap().to_rgb8();
        assert_eq!(thumbnail.dimensions(), (48, 64));
        // Rotation changes a horizontal colour division to a vertical one.
        let left = thumbnail.get_pixel(8, 32).0;
        let right = thumbnail.get_pixel(40, 32).0;
        assert!((i16::from(left[0]) - i16::from(right[0])).abs() > 200);
        assert_eq!(thumbnail.get_pixel(8, 8).0, thumbnail.get_pixel(8, 56).0);
        let (gif, width, height, duration) = export_gif(&rotated, 64, 12).unwrap();
        assert_eq!((width, height), (48, 64));
        assert!((duration.unwrap() - 1.0).abs() < 0.02);
        let gif_target = temp.path().join("rotated.gif");
        std::fs::rename(gif, &gif_target).unwrap();
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
            std::fs::File::open(gif_target).unwrap(),
        ))
        .unwrap();
        let frames = decoder.into_frames().collect_frames().unwrap();
        assert_eq!(frames.len(), 12);
        assert_eq!(frames[0].buffer().dimensions(), (48, 64));
        let left = frames[0].buffer().get_pixel(8, 32).0;
        let right = frames[0].buffer().get_pixel(40, 32).0;
        assert!((i16::from(left[0]) - i16::from(right[0])).abs() > 200);
    }

    /// Copy only this test's isolated fixtures before TempDir drops, including
    /// during an assertion panic. A failed native check must leave evidence.
    struct ReviewArtifacts {
        source: PathBuf,
        name: &'static str,
    }

    impl ReviewArtifacts {
        fn new(source: &Path, name: &'static str) -> Self {
            Self {
                source: source.to_owned(),
                name,
            }
        }
    }

    impl Drop for ReviewArtifacts {
        fn drop(&mut self) {
            let Some(root) = std::env::var_os("KIRI_LINUX_MEDIA_QA_DIR") else {
                return;
            };
            let destination = PathBuf::from(root).join(self.name);
            if std::fs::create_dir_all(&destination).is_err() {
                return;
            }
            let _ = std::fs::write(
                destination.join("test-status.txt"),
                if std::thread::panicking() {
                    "failed\n"
                } else {
                    "passed\n"
                },
            );
            if let Ok(entries) = std::fs::read_dir(&self.source) {
                for entry in entries.flatten() {
                    if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                        let _ = std::fs::copy(entry.path(), destination.join(entry.file_name()));
                    }
                }
            }
        }
    }

    fn display() -> DisplayIdentity {
        DisplayIdentity {
            device_name: "test-display".into(),
            physical_x: 0,
            physical_y: 0,
            physical_width: 2560,
            physical_height: 1440,
            scale_factor: 2.0,
        }
    }

    #[test]
    fn portal_geometry_uses_compositor_coordinates_and_rejects_another_display() {
        assert!(validate_portal_display(&display(), Some((0, 0)), Some((1280, 720))).is_ok());
        assert!(validate_portal_display(&display(), Some((1280, 0)), Some((1280, 720))).is_err());
        assert!(validate_portal_display(&display(), None, Some((1920, 1080))).is_err());
        assert!(validate_portal_display(&display(), None, None).is_ok());
    }

    #[test]
    fn cropped_pixels_follow_stride_and_reject_truncated_buffers() {
        let pixels = [
            1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0,
        ];
        let crop = PixelCrop {
            x: 1,
            y: 0,
            width: 1,
            height: 2,
        };
        assert_eq!(
            crop_bgra_frame(&pixels, 12, 2, 2, crop),
            Some(vec![5, 6, 7, 8, 13, 14, 15, 16])
        );
        assert!(crop_bgra_frame(&pixels[..19], 12, 2, 2, crop).is_none());
        assert!(crop_bgra_frame(&pixels, 7, 2, 2, crop).is_none());
        assert!(crop_bgra_frame(
            &pixels,
            12,
            2,
            2,
            PixelCrop {
                x: u32::MAX,
                ..crop
            }
        )
        .is_none());
    }

    #[test]
    fn recording_crop_rejects_stale_display_size_and_invalid_coordinates() {
        assert!(capture_crop(Rect::new(20.0, 10.0, 100.0, 80.0), 2.0, 2560, 1440).is_ok());
        assert!(capture_crop(Rect::new(1200.0, 10.0, 100.0, 80.0), 2.0, 2560, 1440).is_err());
        assert!(capture_crop(Rect::new(-1.0, 10.0, 100.0, 80.0), 2.0, 2560, 1440).is_err());
        assert!(capture_crop(Rect::new(f64::NAN, 10.0, 100.0, 80.0), 2.0, 2560, 1440).is_err());
    }

    #[tokio::test]
    async fn portal_wait_is_cancelled_and_deadlined_without_a_running_desktop() {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_task = Arc::clone(&stop);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            stop_for_task.store(true, Ordering::Release);
        });
        let start = Instant::now();
        let result = portal_step(
            &stop,
            tokio::time::Instant::now() + Duration::from_secs(120),
            "test",
            std::future::pending::<Result<(), anyhow::Error>>(),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let result = portal_step(
            &AtomicBool::new(false),
            tokio::time::Instant::now(),
            "test",
            std::future::pending::<Result<(), anyhow::Error>>(),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    fn config() -> EncoderConfig {
        EncoderConfig {
            width: 64,
            height: 48,
            fps: 30,
            bitrate: 1_000_000,
            audio: None,
            mic: None,
        }
    }

    fn solid_frame(bgra: [u8; 4]) -> Vec<u8> {
        bgra.repeat(64 * 48)
    }

    fn fixture(path: &Path, bgra: [u8; 4], duration_ms: u64) {
        let encoder = PreparedEncoder::new(&config(), path).unwrap();
        encoder
            .push(
                solid_frame(bgra),
                Duration::ZERO,
                Duration::from_millis(duration_ms),
            )
            .unwrap();
        encoder.appsrc.end_of_stream().unwrap();
        let finalized = wait_for_eos(&encoder.bus, FINALIZE_TIMEOUT, "Fixture encoding");
        let PreparedEncoder {
            pipeline, output, ..
        } = encoder;
        drop(pipeline);
        output.persist_noclobber(path).unwrap();
        finalized.unwrap();
        validate_recording(path, Some((64, 48))).unwrap();
    }

    fn decoded_colors(video: &Path) -> Vec<[u8; 3]> {
        let (pipeline, sink) = decode_pipeline(video, 64, 48, None).unwrap();
        let bus = pipeline_bus(&pipeline).unwrap();
        let mut pixels = Vec::new();
        loop {
            if let Some(sample) = sink.try_pull_sample(gstreamer::ClockTime::from_seconds(5)) {
                let rgba = packed_sample_pixels(
                    &sample,
                    PixelCrop {
                        x: 0,
                        y: 0,
                        width: 64,
                        height: 48,
                    },
                )
                .unwrap();
                pixels.push([rgba[0], rgba[1], rgba[2]]);
            } else {
                assert!(sink.is_eos(), "Decoder did not complete");
                if let Some(message) = bus.pop_filtered(&[gstreamer::MessageType::Error]) {
                    panic!("{}", message_failure(&message, "Test decoding"));
                }
                break;
            }
        }
        pixels
    }

    /// Runs on Linux CI against real installed GStreamer plugins. Fixtures are
    /// isolated from the capture library and require no desktop or camera.
    #[test]
    fn native_mp4_segments_keep_timing_and_merge() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "segments");
        let first = temp.path().join("first.mp4");
        let second = temp.path().join("second.mp4");
        let merged = temp.path().join("merged.mp4");
        fixture(&first, [0, 0, 255, 255], 400);
        fixture(&second, [255, 0, 0, 255], 600);
        let first_duration = validate_recording(&first, Some((64, 48))).unwrap().2;
        let second_duration = validate_recording(&second, Some((64, 48))).unwrap().2;
        std::fs::write(
            temp.path().join("segment-durations.txt"),
            format!("first={first_duration}\nsecond={second_duration}\n"),
        )
        .unwrap();
        assert!(
            (first_duration - 0.4).abs() < 0.03,
            "First segment duration was {first_duration}"
        );
        assert!(
            (second_duration - 0.6).abs() < 0.03,
            "Second segment duration was {second_duration}"
        );
        merge_segments(&[first.clone(), second.clone()], &merged).unwrap();
        let duration = validate_recording(&merged, Some((64, 48))).unwrap().2;
        std::fs::write(
            temp.path().join("merged-duration.txt"),
            format!("{duration}\n"),
        )
        .unwrap();
        assert!(
            (duration - 1.0).abs() < 0.05,
            "Merged duration was {duration}"
        );
        let colors = decoded_colors(&merged);
        assert_eq!(colors.len(), 2);
        assert!(
            colors[0][0] > 220 && colors[0][2] < 30,
            "First segment was not red: {:?}",
            colors[0]
        );
        assert!(
            colors[1][2] > 220 && colors[1][0] < 30,
            "Second segment was not blue: {:?}",
            colors[1]
        );
        let thumbnail = video_first_frame_png(&merged, 32).unwrap();
        std::fs::write(temp.path().join("first-frame.png"), &thumbnail).unwrap();
        let image = image::load_from_memory(&thumbnail).unwrap();
        assert_eq!((image.width(), image.height()), (32, 24));
        let pixel = image.to_rgb8().get_pixel(0, 0).0;
        assert!(pixel[0] > 220 && pixel[2] < 30);
        let (gif, width, height, gif_duration) = export_gif(&merged, 32, 12).unwrap();
        let staged_gif = temp.path().join("merged.gif");
        std::fs::rename(gif, &staged_gif).unwrap();
        assert_eq!((width, height), (32, 24));
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
            std::fs::File::open(&staged_gif).unwrap(),
        ))
        .unwrap();
        let frames = decoder.into_frames().collect_frames().unwrap();
        assert!(
            frames.len() >= 10,
            "Expected one second of GIF frames, got {}",
            frames.len()
        );
        let gif_seconds: f64 = frames
            .iter()
            .map(|frame| {
                let (numerator, denominator) = frame.delay().numer_denom_ms();
                f64::from(numerator) / f64::from(denominator) / 1000.0
            })
            .sum();
        assert!((gif_seconds - frames.len() as f64 / 12.0).abs() <= 0.005_000_001);
        assert!((gif_duration.unwrap() - gif_seconds).abs() < 0.000_001);
        assert!((gif_seconds - duration).abs() < 1.0 / 12.0 + 0.01);
        std::fs::write(temp.path().join("metadata.txt"), format!("width=64\nheight=48\nduration={duration}\nsegment_colors={colors:?}\ngif_frames={}\n", frames.len())).unwrap();
    }

    #[test]
    fn native_encoder_preserves_static_screen_time_and_rejects_partial_output() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "static-screen");
        let output = temp.path().join("static.mp4");
        let (tx, rx) = mpsc::sync_channel(2);
        let encoder =
            LinuxNativeSegmentEncoder::start(&config(), output.clone(), rx, None, None).unwrap();
        tx.send(solid_frame([0, 255, 0, 255])).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        tx.send(solid_frame([0, 255, 0, 255])).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        drop(tx);
        encoder.finish().unwrap();
        let duration = validate_recording(&output, Some((64, 48))).unwrap().2;
        assert!(
            duration > 0.4 && duration < 2.0,
            "A static 500ms screen was encoded as {duration}s"
        );

        let failed = temp.path().join("invalid.mp4");
        let (tx, rx) = mpsc::sync_channel(2);
        let encoder =
            LinuxNativeSegmentEncoder::start(&config(), failed.clone(), rx, None, None).unwrap();
        tx.send(vec![0; 3]).unwrap();
        drop(tx);
        assert!(encoder.finish().is_err());
        assert!(!failed.exists());
        assert_eq!(
            std::fs::read_dir(temp.path()).unwrap().count(),
            1,
            "A failed encoder left a staging file"
        );
    }

    #[test]
    fn merge_failure_keeps_original_segments_and_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "merge-failure");
        let first = temp.path().join("first.mp4");
        fixture(&first, [0, 0, 255, 255], 400);
        let bytes = std::fs::read(&first).unwrap();
        let output = temp.path().join("output.mp4");
        assert!(
            merge_segments(&[first.clone(), temp.path().join("missing.mp4")], &output).is_err()
        );
        assert!(!output.exists());
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
        std::fs::write(&output, b"existing destination").unwrap();
        assert!(merge_segments(std::slice::from_ref(&first), &output).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"existing destination");
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
    }

    pub(super) fn audio_fixture(path: &Path, frequencies: &[f64], millis: u64) {
        let prepared =
            PreparedEncoder::with_audio(&config(), path, AudioSetup::Tones(frequencies.len()))
                .unwrap();
        for (index, frequency) in frequencies.iter().enumerate() {
            let source = prepared
                .pipeline
                .by_name(&format!("audio_{index}"))
                .unwrap();
            source.set_property("freq", *frequency);
            source.set_property("volume", 0.15f64);
            source.set_property("samplesperbuffer", 480i32);
        }
        let (tx, rx) = mpsc::sync_channel(2);
        let output = path.to_owned();
        let worker = std::thread::spawn(move || {
            encode_bgra_mp4(
                prepared,
                &output,
                rx,
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
        });
        tx.send(solid_frame([0, 255, 0, 255])).unwrap();
        std::thread::sleep(Duration::from_millis(millis));
        drop(tx);
        worker.join().unwrap().unwrap();
    }

    fn decoded_audio(video: &Path) -> Vec<f32> {
        let pipeline = pipeline("filesrc name=input ! decodebin ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,channels=1,rate=48000 ! appsink name=sink max-buffers=2 drop=false sync=false", "test audio decoding").unwrap();
        set_file(&pipeline, "input", video).unwrap();
        let sink = pipeline
            .by_name("sink")
            .unwrap()
            .downcast::<gstreamer_app::AppSink>()
            .unwrap();
        let bus = pipeline_bus(&pipeline).unwrap();
        pipeline.set_state(gstreamer::State::Playing).unwrap();
        let mut samples = Vec::new();
        loop {
            if let Some(sample) = sink.try_pull_sample(gstreamer::ClockTime::from_seconds(5)) {
                let bytes = sample.buffer().unwrap().map_readable().unwrap();
                samples.extend(
                    bytes
                        .as_slice()
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|chunk| f32::from_le_bytes(*chunk)),
                );
            } else {
                assert!(sink.is_eos(), "Audio decoder stalled");
                if let Some(message) = bus.pop_filtered(&[gstreamer::MessageType::Error]) {
                    panic!("{}", message_failure(&message, "audio test"));
                }
                break;
            }
        }
        samples
    }

    fn tone_amplitude(samples: &[f32], frequency: f64) -> f64 {
        let (sin, cos) =
            samples
                .iter()
                .enumerate()
                .fold((0.0, 0.0), |(sin, cos), (index, sample)| {
                    let phase = 2.0 * std::f64::consts::PI * frequency * index as f64 / 48_000.0;
                    (
                        sin + f64::from(*sample) * phase.sin(),
                        cos + f64::from(*sample) * phase.cos(),
                    )
                });
        2.0 * sin.hypot(cos) / samples.len() as f64
    }

    // Native source clocks and audiorate can change phase while preserving a
    // tone. A single coherent projection across the whole recording can cancel
    // two loud regions. Measure power in 25ms windows (11 / 22 whole cycles at
    // the fixture's 440 / 880Hz), and require it in rolling 100ms intervals.
    // Advancing by 25ms catches dropouts that straddle interval boundaries.
    fn tone_window_amplitudes(samples: &[f32], frequency: f64) -> Vec<f64> {
        let amplitudes = samples
            .as_chunks::<1_200>()
            .0
            .iter()
            .map(|window| tone_amplitude(window, frequency))
            .collect::<Vec<_>>();
        amplitudes
            .windows(4)
            .map(|interval| (interval.iter().map(|value| value * value).sum::<f64>() / 4.0).sqrt())
            .collect()
    }

    #[test]
    fn native_tone_oracle_accepts_phase_changes_but_rejects_missing_audio() {
        let phase_changed = (0..24_000)
            .map(|index| {
                let phase = if index / 4_800 % 2 == 0 {
                    0.0
                } else {
                    std::f64::consts::PI
                };
                (0.15
                    * (2.0 * std::f64::consts::PI * 440.0 * index as f64 / 48_000.0 + phase).sin())
                    as f32
            })
            .collect::<Vec<_>>();
        // The old oracle wrongly called this audible, continuous-energy tone
        // missing. The local oracle still rejects silence, a wrong route, and
        // one missing 100ms interior interval rather than averaging it away.
        assert!(tone_amplitude(&phase_changed, 440.0) < 0.05);
        let present = |samples: &[f32], frequency| {
            let windows = tone_window_amplitudes(samples, frequency);
            !windows.is_empty() && windows.iter().all(|amplitude| *amplitude > 0.08)
        };
        assert!(present(&phase_changed, 440.0));
        assert!(!present(&phase_changed, 880.0));
        assert!(!present(&vec![0.0; 24_000], 440.0));
        let mut missing_interval = phase_changed.clone();
        missing_interval[9_600..14_400].fill(0.0);
        assert!(!present(&missing_interval, 440.0));
        let mut shifted_missing = phase_changed.clone();
        shifted_missing[12_000..16_800].fill(0.0);
        assert!(!present(&shifted_missing, 440.0));
    }

    // Only synthetic audio tests install these probes.
    // Keep native-input / corrected / mixed PCM and timing evidence so a CI
    // failure can distinguish the producer, clock correction and encoder.
    #[derive(Default)]
    struct AudioTraceData {
        bytes: Vec<u8>,
        buffers: Vec<String>,
        truncated: bool,
        first_pts: Option<u64>,
        max_residual_ns: u64,
    }

    fn native_fixture_tolerance(
        observations: &[crate::linux_audio::NativeTimingObservation],
        index: usize,
    ) -> Result<u64> {
        let source = observations
            .iter()
            .filter(|item| item.index == index)
            .collect::<Vec<_>>();
        let first = source
            .first()
            .context("Missing native timing negotiation")?;
        if first.source != "kiri_test_mic" || first.is_monitor {
            return Ok(5_000_000);
        }
        // This owned microphone is a remapped null-sink monitor. Pulse clamps
        // its negative source latency to zero, and omits the monitor's sink
        // correction. It therefore has one negotiated fragment of clock
        // quantization. This allowance is confined to the verified fixture;
        // it is not a physical microphone or Pulse accuracy guarantee.
        for item in &source {
            if item.source != "kiri_test_mic"
                || item.is_monitor
                || item.configured_source_us != 10_000
                || item.fragment_bytes != 3_840
            {
                bail!("Owned remap microphone timing negotiation changed: {item:?}");
            }
        }
        let negotiated = (u64::from(first.fragment_bytes) * 1_000_000_000 / 384_000)
            .max(first.configured_source_us * 1_000);
        Ok(negotiated + 1_000_000)
    }

    struct NativeAudioTrace {
        timing_observations: crate::linux_audio::NativeTimingObservations,
        path: PathBuf,
        stages: Vec<(String, Arc<std::sync::Mutex<AudioTraceData>>)>,
        rates: Vec<Arc<std::sync::Mutex<Option<String>>>>,
    }

    impl NativeAudioTrace {
        fn new(prepared: &mut PreparedEncoder, path: &Path, count: usize) -> Self {
            let timing_observations = Arc::new(std::sync::Mutex::new(Vec::new()));
            prepared
                .audio
                .observe_native_timing(timing_observations.clone());
            let mut trace = Self {
                timing_observations,
                path: path.to_owned(),
                stages: Vec::new(),
                rates: Vec::new(),
            };
            for index in 0..count {
                let source = prepared
                    .pipeline
                    .by_name(&format!("audio_{index}"))
                    .unwrap();
                trace.observe(format!("input-{index}"), source.static_pad("src").unwrap());
                let queue = prepared
                    .pipeline
                    .by_name(&format!("audio_queue_{index}"))
                    .unwrap();
                let sink = queue.static_pad("sink").unwrap();
                let rate = sink.peer().unwrap().parent_element().unwrap();
                let snapshot = Arc::new(std::sync::Mutex::new(None));
                let counters = snapshot.clone();
                // Read counters on EOS, before the encoder drops the pipeline
                // and audiorate resets its statistics on PAUSED -> READY.
                sink.add_probe(gstreamer::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
                    if info
                        .event()
                        .is_some_and(|event| event.type_() == gstreamer::EventType::Eos)
                    {
                        *counters.lock().unwrap() = Some(format!(
                            "input={index} in={} out={} add={} drop={}",
                            rate.property::<u64>("in"),
                            rate.property::<u64>("out"),
                            rate.property::<u64>("add"),
                            rate.property::<u64>("drop")
                        ));
                    }
                    gstreamer::PadProbeReturn::Ok
                });
                trace.rates.push(snapshot);
                trace.observe(format!("corrected-{index}"), sink);
            }
            trace.observe(
                "mixed".into(),
                prepared
                    .pipeline
                    .by_name("audio_mix")
                    .unwrap()
                    .static_pad("src")
                    .unwrap(),
            );
            trace
        }

        fn native_continuity_errors(&self) -> Vec<String> {
            let mut errors = Vec::new();
            let observations = self.timing_observations.lock().unwrap().clone();
            for (stage, data) in &self.stages {
                if stage.starts_with("input-") {
                    let (truncated, residual) = {
                        let data = data.lock().unwrap();
                        (data.truncated, data.max_residual_ns)
                    };
                    let index = stage.strip_prefix("input-").unwrap().parse().unwrap();
                    let tolerance = match native_fixture_tolerance(&observations, index) {
                        Ok(tolerance) => tolerance,
                        Err(error) => {
                            errors.push(error.to_string());
                            continue;
                        }
                    };
                    if truncated || residual > tolerance {
                        errors.push(format!("{} {stage}: truncated={truncated}, native timestamp residual={residual}ns, allowed={tolerance}ns", self.path.display()));
                    }
                }
            }
            for snapshot in &self.rates {
                let counters = snapshot.lock().unwrap().clone();
                if counters
                    .as_ref()
                    .is_none_or(|counters| !counters.ends_with("add=0 drop=0"))
                {
                    errors.push(format!(
                        "{} virtual source inserted/dropped samples or missed EOS: {counters:?}",
                        self.path.display()
                    ));
                }
            }
            errors
        }

        fn assert_native_continuity(&self) {
            let errors = self.native_continuity_errors();
            assert!(errors.is_empty(), "{errors:?}");
        }

        fn observe(&mut self, stage: String, pad: gstreamer::Pad) {
            let data = Arc::new(std::sync::Mutex::new(AudioTraceData::default()));
            let samples = data.clone();
            let started = Instant::now();
            pad.add_probe(gstreamer::PadProbeType::BUFFER, move |pad, info| {
                if let Some(buffer) = info.buffer() {
                    if let Ok(bytes) = buffer.map_readable() {
                        let mut data = samples.lock().unwrap();
                        if data.bytes.len() + bytes.len() <= 4_000_000 {
                            if let Some(pts) = buffer.pts() {
                                let first = *data.first_pts.get_or_insert(pts.nseconds());
                                let expected =
                                    first + data.bytes.len() as u64 * 1_000_000_000 / 384_000;
                                data.max_residual_ns =
                                    data.max_residual_ns.max(pts.nseconds().abs_diff(expected));
                            }
                            data.bytes.extend_from_slice(bytes.as_slice());
                            data.buffers.push(format!(
                                "{}\t{:?}\t{:?}\t{}\t{:?}",
                                started.elapsed().as_nanos(),
                                buffer.pts().map(|time| time.nseconds()),
                                buffer.duration().map(|time| time.nseconds()),
                                bytes.len(),
                                pad.current_caps()
                            ));
                        } else {
                            data.truncated = true;
                        }
                    }
                }
                gstreamer::PadProbeReturn::Ok
            });
            self.stages.push((stage, data));
        }
    }

    impl Drop for NativeAudioTrace {
        fn drop(&mut self) {
            let observations = self
                .timing_observations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = std::fs::write(
                self.path.with_extension("native-timing.txt"),
                format!("{observations:#?}\n"),
            );
            drop(observations);
            for (stage, data) in &self.stages {
                let data = data.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let _ = std::fs::write(
                    self.path.with_extension(format!("{stage}.f32le")),
                    &data.bytes,
                );
                let _ = std::fs::write(
                    self.path.with_extension(format!("{stage}.tsv")),
                    format!(
                        "observed_ns\tpts_ns\tduration_ns\tbytes\tcaps\n{}\ntruncated={}\n",
                        data.buffers.join("\n"),
                        data.truncated
                    ),
                );
            }
            let rates = self
                .rates
                .iter()
                .map(|snapshot| {
                    snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone()
                        .unwrap_or_else(|| "EOS not observed".into())
                })
                .collect::<Vec<_>>()
                .join("\n");
            let _ = std::fs::write(self.path.with_extension("audiorate.txt"), rates);
        }
    }

    #[test]
    fn virtual_microphone_tolerance_requires_exact_owned_negotiation() {
        let mut observation = crate::linux_audio::NativeTimingObservation {
            index: 0,
            source: "kiri_test_mic".into(),
            is_monitor: false,
            configured_source_us: 10_000,
            fragment_bytes: 3_840,
        };
        assert_eq!(
            native_fixture_tolerance(&[observation.clone()], 0).unwrap(),
            11_000_000
        );
        observation.configured_source_us = 10_001;
        assert!(native_fixture_tolerance(&[observation.clone()], 0).is_err());
        observation.configured_source_us = 10_000;
        observation.fragment_bytes = 3_848;
        assert!(native_fixture_tolerance(&[observation.clone()], 0).is_err());
        observation.fragment_bytes = 3_840;
        observation.source = "another-input".into();
        assert_eq!(
            native_fixture_tolerance(&[observation], 0).unwrap(),
            5_000_000
        );
        assert!(native_fixture_tolerance(&[], 0).is_err());
    }

    #[test]
    fn native_audio_trace_survives_a_continuity_assertion() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("failed.mp4");
        let trace = NativeAudioTrace {
            timing_observations: Arc::new(std::sync::Mutex::new(vec![
                crate::linux_audio::NativeTimingObservation {
                    index: 0,
                    source: "kiri_test_mic".into(),
                    is_monitor: false,
                    configured_source_us: 10_000,
                    fragment_bytes: 3_840,
                },
            ])),
            path: path.clone(),
            stages: vec![(
                "input-0".into(),
                Arc::new(std::sync::Mutex::new(AudioTraceData {
                    max_residual_ns: 27_000_000,
                    ..AudioTraceData::default()
                })),
            )],
            rates: Vec::new(),
        };
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            trace.assert_native_continuity()
        }));
        assert!(failure.is_err());
        drop(trace);
        assert!(path.with_extension("input-0.tsv").is_file());
        assert!(path.with_extension("input-0.f32le").is_file());
    }

    #[test]
    fn native_audio_single_and_mixed_tracks_decode_with_both_tones() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "audio-tones");
        for (name, frequencies) in [
            ("system", vec![440.0]),
            ("microphone", vec![880.0]),
            ("mixed", vec![440.0, 880.0]),
        ] {
            let path = temp.path().join(format!("{name}.mp4"));
            audio_fixture(&path, &frequencies, 800);
            let duration = validate_recording_tracks(&path, Some((64, 48)), Some(true))
                .unwrap()
                .2;
            assert!((duration - 0.8).abs() < 0.1, "{name} duration {duration}");
            let samples = decoded_audio(&path);
            assert!((samples.len() as f64 / 48_000.0 - duration).abs() < 0.05);
            let middle = &samples[4800..samples.len() - 4800];
            for frequency in frequencies {
                assert!(
                    tone_amplitude(middle, frequency) > 0.08,
                    "missing {frequency}Hz in {name}"
                );
            }
        }
        let silent = temp.path().join("audio-off.mp4");
        fixture(&silent, [0, 255, 0, 255], 400);
        validate_recording_tracks(&silent, Some((64, 48)), Some(false)).unwrap();
    }

    #[test]
    fn native_audio_pause_merge_preserves_tones_and_excludes_paused_time() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "audio-pause-merge");
        let first = temp.path().join("first.mp4");
        let second = temp.path().join("second.mp4");
        let merged = temp.path().join("merged.mp4");
        audio_fixture(&first, &[440.0], 700);
        std::thread::sleep(Duration::from_millis(300));
        audio_fixture(&second, &[880.0], 900);
        merge_segments(&[first, second], &merged).unwrap();
        let duration = validate_recording_tracks(&merged, Some((64, 48)), Some(true))
            .unwrap()
            .2;
        assert!((duration - 1.6).abs() < 0.1, "merged duration {duration}");
        let samples = decoded_audio(&merged);
        let early = &samples[4800..24000];
        let late = &samples[48000..67200];
        assert!(tone_amplitude(early, 440.0) > 0.08);
        assert!(tone_amplitude(early, 880.0) < 0.01);
        assert!(tone_amplitude(late, 880.0) > 0.08);
        assert!(tone_amplitude(late, 440.0) < 0.01);
    }

    #[test]
    fn native_audio_many_pauses_keep_common_boundaries_and_decode_preroll_once() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "audio-many-pauses");
        let first = temp.path().join("first.mp4");
        let second = temp.path().join("second.mp4");
        audio_fixture(&first, &[440.0], 170);
        audio_fixture(&second, &[880.0], 210);
        let durations = [
            validate_recording(&first, None).unwrap().2,
            validate_recording(&second, None).unwrap().2,
        ];
        let segments = (0..24)
            .map(|index| {
                if index % 2 == 0 {
                    first.clone()
                } else {
                    second.clone()
                }
            })
            .collect::<Vec<_>>();
        let merged = temp.path().join("merged.mp4");
        merge_segments(&segments, &merged).unwrap();
        let audio = decoded_audio(&merged);
        let pipeline = pipeline("filesrc name=input ! qtdemux ! video/x-h264 ! appsink name=sink max-buffers=2 drop=false sync=false", "merge boundary inspection").unwrap();
        set_file(&pipeline, "input", &merged).unwrap();
        let sink = pipeline
            .by_name("sink")
            .unwrap()
            .downcast::<gstreamer_app::AppSink>()
            .unwrap();
        pipeline.set_state(gstreamer::State::Playing).unwrap();
        let mut boundaries = Vec::new();
        while let Some(sample) = sink.try_pull_sample(gstreamer::ClockTime::from_seconds(5)) {
            let buffer = sample.buffer().unwrap();
            if !buffer.flags().contains(gstreamer::BufferFlags::DELTA_UNIT) {
                boundaries.push(buffer.pts().unwrap().nseconds() as f64 / 1e9);
            }
        }
        assert!(sink.is_eos());
        assert_eq!(boundaries.len(), segments.len());
        let mut expected = 0.0;
        for (index, boundary) in boundaries.into_iter().enumerate() {
            assert!(
                (boundary - expected).abs() < 0.002,
                "pause {index}: video {boundary}, audio base {expected}"
            );
            let from = ((expected + 0.05) * 48_000.0) as usize;
            let to = ((expected + 0.13) * 48_000.0) as usize;
            let wanted = if index % 2 == 0 { 440.0 } else { 880.0 };
            let unwanted = if index % 2 == 0 { 880.0 } else { 440.0 };
            assert!(
                tone_amplitude(&audio[from..to], wanted) > 0.06,
                "wanted tone missing at pause {index}"
            );
            assert!(
                tone_amplitude(&audio[from..to], unwanted) < 0.015,
                "previous tone leaked at pause {index}"
            );
            expected += durations[index % 2];
        }
        assert!((audio.len() as f64 / 48_000.0 - expected).abs() < 0.04);
    }

    #[test]
    fn native_audio_accepts_pcm_delivered_after_its_capture_timestamp() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("delayed-pcm.mp4");
        let mut prepared =
            PreparedEncoder::with_audio(&config(), &path, AudioSetup::DelayedPcm).unwrap();
        let trace = NativeAudioTrace::new(&mut prepared, &path, 1);
        let source = prepared
            .pipeline
            .by_name("audio_0")
            .unwrap()
            .downcast::<gstreamer_app::AppSrc>()
            .unwrap();
        let (tx, rx) = mpsc::sync_channel(2);
        let output = path.clone();
        let worker = std::thread::spawn(move || {
            encode_bgra_mp4(
                prepared,
                &output,
                rx,
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
        });
        tx.send(solid_frame([0, 255, 0, 255])).unwrap();
        // Real native capture arrives after the samples' audible time. appsrc
        // has no device-reported latency unlike audiotestsrc/pulsesrc.
        std::thread::sleep(Duration::from_millis(80));
        for block in 0..70 {
            let mut bytes = Vec::new();
            for frame in 0..480 {
                let sample = (0.15
                    * (2.0 * std::f64::consts::PI * 440.0 * (block * 480 + frame) as f64
                        / 48_000.0)
                        .sin()) as f32;
                bytes.extend_from_slice(&sample.to_le_bytes());
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            let mut buffer = gstreamer::Buffer::from_mut_slice(bytes);
            let data = buffer.get_mut().unwrap();
            data.set_pts(gstreamer::ClockTime::from_mseconds(block as u64 * 10));
            data.set_duration(gstreamer::ClockTime::from_mseconds(10));
            source.push_buffer(buffer).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(tx);
        worker.join().unwrap().unwrap();
        drop(trace);
        let counters = std::fs::read_to_string(path.with_extension("audiorate.txt")).unwrap();
        assert!(
            counters.contains("in=33600 out=33600 add=0 drop=0"),
            "{counters}"
        );
        let audio = decoded_audio(&path);
        assert!(
            tone_amplitude(&audio[9600..28800], 440.0) > 0.08,
            "live mixer discarded delayed but correctly timestamped PCM"
        );
    }

    #[test]
    fn native_audio_failure_does_not_publish_a_partial_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("overload.mp4");
        let prepared = PreparedEncoder::with_audio(&config(), &path, AudioSetup::Tones(1)).unwrap();
        prepared
            .pipeline
            .by_name("audio_queue_0")
            .unwrap()
            .emit_by_name::<()>("overrun", &[]);
        let (tx, rx) = mpsc::sync_channel(2);
        tx.send(solid_frame([0, 0, 0, 255])).unwrap();
        drop(tx);
        assert!(encode_bgra_mp4(
            prepared,
            &path,
            rx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    #[ignore = "requires scripts/qa/linux-audio.sh owned Pulse server PID"]
    fn native_pulse_private_server_cancel_survives_a_hung_service() {
        assert_eq!(std::env::var("KIRI_LINUX_PULSE_QA").as_deref(), Ok("1"));
        let pid = std::env::var("KIRI_LINUX_PULSE_QA_SERVER_PID")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert!(pid > 1);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cancelled.mp4");
        let config = EncoderConfig {
            audio: Some(crate::linux_audio::AUDIO_SPEC),
            ..config()
        };
        let prepared = PreparedEncoder::new(&config, &path).unwrap();
        let (ready, observed) = mpsc::sync_channel(1);
        prepared
            .pipeline
            .by_name("audio_queue_0")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                let _ = ready.try_send(());
                gstreamer::PadProbeReturn::Remove
            });
        let (tx, rx) = mpsc::sync_channel(2);
        let encoder =
            LinuxNativeSegmentEncoder::start_prepared(prepared, path.clone(), rx).unwrap();
        tx.send(solid_frame([0, 255, 0, 255])).unwrap();
        observed
            .recv_timeout(Duration::from_secs(4))
            .expect("real PCM before fault injection");
        struct ResumeServer(u32);
        impl Drop for ResumeServer {
            fn drop(&mut self) {
                let _ = std::process::Command::new("kill")
                    .args(["-CONT", &self.0.to_string()])
                    .status();
            }
        }
        let resume = ResumeServer(pid);
        assert!(std::process::Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .unwrap()
            .success());
        let start = Instant::now();
        encoder.cancel();
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "cancellation waited for an unresponsive sound service"
        );
        drop(tx);
        drop(resume);
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_dir(temp.path()).unwrap().count(),
            0,
            "cancelled recording left staged audio/video"
        );
    }

    #[test]
    #[ignore = "requires scripts/qa/linux-audio.sh private Pulse server; never uses desktop audio"]
    fn native_pulse_private_server_captures_verified_sources() {
        assert_eq!(std::env::var("KIRI_LINUX_PULSE_QA").as_deref(), Ok("1"));
        let sources = crate::linux_audio::selected_sources(true, true).unwrap();
        assert_eq!(sources[0].name, "kiri_test_system.monitor");
        assert_eq!(sources[1].name, "kiri_test_mic");
        // Generator liveness alone is insufficient after server startup or a
        // deliberate pause: wait for real non-silent PCM on BOTH test routes.
        // This also verifies the native capture path independently of the mux.
        {
            let mut capture = crate::linux_audio::NativeCapture::new(&sources).unwrap();
            let start = Instant::now();
            capture.start().unwrap();
            let mut heard = [false; 2];
            while !heard.iter().all(|heard| *heard) && start.elapsed() < Duration::from_secs(5) {
                capture
                    .pump(start, None, |index, bytes, _, _| {
                        heard[index] |= bytes
                            .as_chunks::<4>()
                            .0
                            .iter()
                            .any(|chunk| f32::from_le_bytes(*chunk).abs() > 0.05);
                        Ok(())
                    })
                    .unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                heard.iter().all(|heard| *heard),
                "synthetic Pulse generators did not deliver both tones"
            );
        }
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "pulse-private-server");
        let mut continuity_errors = Vec::new();
        for (name, system, microphone, frequencies) in [
            ("system", true, false, vec![440.0]),
            ("microphone", false, true, vec![880.0]),
            ("mixed", true, true, vec![440.0, 880.0]),
        ] {
            let path = temp.path().join(format!("{name}.mp4"));
            let config = EncoderConfig {
                audio: system.then_some(crate::linux_audio::AUDIO_SPEC),
                mic: microphone.then_some(crate::linux_audio::AUDIO_SPEC),
                ..config()
            };
            let mut prepared = PreparedEncoder::new(&config, &path).unwrap();
            let trace = NativeAudioTrace::new(&mut prepared, &path, frequencies.len());
            let (tx, rx) = mpsc::sync_channel(2);
            let encoder =
                LinuxNativeSegmentEncoder::start_prepared(prepared, path.clone(), rx).unwrap();
            tx.send(solid_frame([255, 0, 0, 255])).unwrap();
            // Five seconds of native mixed capture spans multiple mature
            // auto-timing refreshes (up to 1.5s apart), not only startup.
            let millis = if system && microphone { 5_000 } else { 800 };
            std::thread::sleep(Duration::from_millis(millis));
            drop(tx);
            encoder.finish().unwrap();
            continuity_errors.extend(trace.native_continuity_errors());
            drop(trace);
            validate_recording_tracks(&path, Some((64, 48)), Some(true)).unwrap();
            let samples = decoded_audio(&path);
            assert!(samples.len() > 19_200, "{name} audio is too short");
            // Preserve explicit startup/tail exclusions; every interior 100ms
            // interval must contain each requested tone, and no wrong route.
            let interior = &samples[9_600..samples.len() - 4_800];
            let windows = [440.0, 880.0]
                .map(|frequency| (frequency, tone_window_amplitudes(interior, frequency)));
            std::fs::write(
                path.with_extension("tone-windows.txt"),
                format!("{windows:?}\n"),
            )
            .unwrap();
            for (frequency, amplitudes) in windows {
                if frequencies.contains(&frequency) {
                    assert!(
                        amplitudes.iter().all(|amplitude| *amplitude > 0.08),
                        "{name} missing {frequency}Hz in a 100ms interval: {amplitudes:?}"
                    );
                } else {
                    assert!(
                        amplitudes.iter().all(|amplitude| *amplitude < 0.02),
                        "{name} contains wrong-route {frequency}Hz: {amplitudes:?}"
                    );
                }
            }
        }
        let start = Instant::now();
        let mut peaks = Vec::new();
        crate::linux_audio::microphone_check(
            || start.elapsed() < Duration::from_millis(400),
            |_, peak| {
                peaks.push(peak);
                Ok(())
            },
        )
        .unwrap();
        assert!(peaks.iter().any(|peak| *peak > 0.05));
        assert!(continuity_errors.is_empty(), "{continuity_errors:?}");
    }

    #[test]
    #[ignore = "requires scripts/qa/linux-audio-fifo.sh private FIFO sink; microphone stays off"]
    fn native_pulse_fifo_system_audio_and_pause_merge() {
        assert_eq!(
            std::env::var("KIRI_LINUX_PULSE_FIFO_QA").as_deref(),
            Ok("1")
        );
        let sources = crate::linux_audio::selected_sources(true, false).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "fifo_output.monitor");
        // FIFO playback can take longer to prime than a null sink. Prove the
        // generated route is audible before asking the encoder to record it.
        {
            let mut capture = crate::linux_audio::NativeCapture::new(&sources).unwrap();
            let origin = Instant::now();
            capture.start().unwrap();
            let mut heard = false;
            while !heard && origin.elapsed() < Duration::from_secs(5) {
                capture
                    .pump(origin, None, |_, bytes, _, _| {
                        heard |= bytes
                            .as_chunks::<4>()
                            .0
                            .iter()
                            .any(|sample| f32::from_le_bytes(*sample).abs() > 0.05);
                        Ok(())
                    })
                    .unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(heard, "FIFO test generator never delivered its tone");
            eprintln!("FIFO test tone verified after {:?}", origin.elapsed());
        }
        // The same audible route must reject the legacy 250ms native budget.
        // This counterfactual prevents a lower-latency fixture from passing
        // without exercising the dropped-future-PCM regression.
        {
            let mut legacy =
                crate::linux_audio::NativeCapture::with_legacy_queue(&sources).unwrap();
            let origin = Instant::now();
            legacy.start().unwrap();
            let mut failure = None;
            while origin.elapsed() < Duration::from_secs(2) {
                if let Err(error) = legacy.pump(origin, None, |_, _, _, _| Ok(())) {
                    failure = Some(error.to_string());
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let failure = failure.expect("FIFO fixture did not reproduce the legacy queue failure");
            assert!(
                failure.contains("native timestamp discontinuity")
                    || failure.contains("native overflow or device move"),
                "Unexpected legacy failure: {failure}"
            );
            eprintln!("Verified legacy FIFO failure: {failure}");
        }
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "pulse-fifo");
        let mut segments = Vec::new();
        let mut active_duration = 0.0;
        for index in 0..2 {
            let path = temp.path().join(format!("segment-{index}.mp4"));
            let config = EncoderConfig {
                audio: Some(crate::linux_audio::AUDIO_SPEC),
                mic: None,
                ..config()
            };
            let mut prepared = PreparedEncoder::new(&config, &path).unwrap();
            let trace = NativeAudioTrace::new(&mut prepared, &path, 1);
            let (tx, rx) = mpsc::sync_channel(2);
            let encoder =
                LinuxNativeSegmentEncoder::start_prepared(prepared, path.clone(), rx).unwrap();
            tx.send(solid_frame([255, 0, 0, 255])).unwrap();
            std::thread::sleep(Duration::from_secs(4));
            drop(tx);
            encoder.finish().unwrap();
            trace.assert_native_continuity();
            drop(trace);
            let (_, _, duration) =
                validate_recording_tracks(&path, Some((64, 48)), Some(true)).unwrap();
            assert!(
                (3.3..4.1).contains(&duration),
                "FIFO segment duration: {duration}"
            );
            active_duration += duration;
            let samples = decoded_audio(&path);
            assert!(
                tone_window_amplitudes(&samples[..9_600], 440.0)
                    .iter()
                    .all(|amplitude| *amplitude > 0.08),
                "FIFO preparation silence leaked into the recording"
            );
            let amplitudes = tone_window_amplitudes(&samples[9_600..samples.len() - 4_800], 440.0);
            assert!(
                amplitudes.iter().all(|amplitude| *amplitude > 0.08),
                "FIFO lost tone: {amplitudes:?}"
            );
            segments.push(path);
            if index == 0 {
                std::thread::sleep(Duration::from_millis(700));
            }
        }
        let merged = temp.path().join("paused-merged.mp4");
        merge_segments(&segments, &merged).unwrap();
        let (_, _, duration) =
            validate_recording_tracks(&merged, Some((64, 48)), Some(true)).unwrap();
        assert!(
            (duration - active_duration).abs() < 0.05,
            "paused/preparation wall time leaked: {duration}, active {active_duration}"
        );
        assert!(tone_window_amplitudes(&decoded_audio(&merged), 440.0)
            .iter()
            .all(|amplitude| *amplitude > 0.08));
        let cancelled = temp.path().join("cancelled-during-preparation.mp4");
        let config = EncoderConfig {
            audio: Some(crate::linux_audio::AUDIO_SPEC),
            ..config()
        };
        let prepared = PreparedEncoder::new(&config, &cancelled).unwrap();
        let (tx, rx) = mpsc::sync_channel(2);
        let encoder =
            LinuxNativeSegmentEncoder::start_prepared(prepared, cancelled.clone(), rx).unwrap();
        tx.send(solid_frame([255, 0, 0, 255])).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        let cancel_started = Instant::now();
        encoder.cancel();
        assert!(cancel_started.elapsed() < Duration::from_secs(1));
        assert!(!cancelled.exists());
        drop(tx);
        let silent = temp.path().join("silent.mp4");
        fixture(&silent, [0, 0, 255, 255], 400);
        validate_recording_tracks(&silent, Some((64, 48)), Some(false)).unwrap();
    }

    #[test]
    #[ignore = "60-second native A/V clock acceptance; run explicitly for audio changes"]
    fn native_audio_long_recording_keeps_shared_clock() {
        let temp = tempfile::tempdir().unwrap();
        let _review = ReviewArtifacts::new(temp.path(), "audio-long-clock");
        let path = temp.path().join("long.mp4");
        audio_fixture(&path, &[440.0, 880.0], 60_000);
        let duration = validate_recording_tracks(&path, Some((64, 48)), Some(true))
            .unwrap()
            .2;
        let samples = decoded_audio(&path);
        assert!((duration - 60.0).abs() < 0.1, "video duration {duration}");
        assert!((samples.len() as f64 / 48_000.0 - duration).abs() < 0.05);
        for window in [
            &samples[48000..96000],
            &samples[samples.len() - 96000..samples.len() - 48000],
        ] {
            assert!(tone_amplitude(window, 440.0) > 0.08);
            assert!(tone_amplitude(window, 880.0) > 0.08);
        }
    }

    #[test]
    fn media_error_and_timeout_do_not_count_as_successful_eos() {
        let error_pipeline = pipeline(
            "videotestsrc num-buffers=2 ! identity error-after=1 ! fakesink",
            "Error test",
        )
        .unwrap();
        let bus = pipeline_bus(&error_pipeline).unwrap();
        let _ = error_pipeline.set_state(gstreamer::State::Playing);
        assert!(wait_for_eos(&bus, Duration::from_secs(3), "Error test").is_err());
        let idle = pipeline_bus(&pipeline("appsrc ! fakesink", "Timeout test").unwrap()).unwrap();
        assert!(
            wait_for_eos(&idle, Duration::from_millis(1), "Timeout test")
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
    }
}
