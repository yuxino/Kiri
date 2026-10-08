//! Async libpulse PCM feeds the recording GStreamer pipeline on its clock.
//! Pulse introspection never opens a stream or starts a daemon. Only an explicit
//! recording/check opens the pinned input; screen-sharing consent is unrelated.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use gstreamer::prelude::*;
use libpulse_binding as pulse;

pub const AUDIO_SPEC: crate::record::AudioSpec = crate::record::AudioSpec {
    sample_rate: 48_000,
    channels: 2,
    format: crate::record::AudioSampleFormat::F32,
};
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(3);
pub const AUDIO_UNAVAILABLE: &str = "Linux audio is unavailable. Check the PulseAudio or PipeWire audio service and the selected sound devices.";
pub const MICROPHONE_UNAVAILABLE: &str =
    "No microphone input is available. Select an unmuted input device in your sound settings.";
pub const AUDIO_RECORDING_FAILED: &str = "Audio recording stopped. Check the sound devices and audio service, then start a new recording.";

#[derive(Debug, Clone)]
pub struct AudioSource {
    pub name: String,
    pub description: String,
    index: u32,
    server: String,
    monitor_of: Option<String>,
    muted: bool,
}

/// Static capability only. Do not access devices while rendering an overlay.
pub fn supported() -> bool {
    gstreamer::init().is_ok()
        && [
            "appsrc",
            "audiorate",
            "audioconvert",
            "audioresample",
            "audiomixer",
            "avenc_aac",
            "aacparse",
        ]
        .iter()
        .all(|name| gstreamer::ElementFactory::find(name).is_some())
}

fn local_server_address() -> Result<String> {
    let server = match std::env::var("PULSE_SERVER") {
        Ok(server) if !server.is_empty() => server,
        _ => {
            let runtime = std::env::var_os("XDG_RUNTIME_DIR").context(AUDIO_UNAVAILABLE)?;
            format!(
                "unix:{}",
                std::path::Path::new(&runtime)
                    .join("pulse/native")
                    .to_str()
                    .context(AUDIO_UNAVAILABLE)?
            )
        }
    };
    validate_local_server(&server)?;
    Ok(server)
}

fn validate_local_server(server: &str) -> Result<()> {
    let path = server.strip_prefix("unix:").unwrap_or(server);
    if !std::path::Path::new(path).is_absolute() || path.chars().any(char::is_whitespace) {
        bail!(AUDIO_UNAVAILABLE);
    }
    Ok(())
}

fn drain_mainloop(mainloop: &mut pulse::mainloop::standard::Mainloop) -> Result<()> {
    let started = Instant::now();
    // Pulse gives deferred transport work priority over timers. Consuming PCM
    // schedules another shared-memory release defer, so one iteration per
    // video poll can starve timing/control events forever. Drain ready work
    // before consuming the next batch, without turning this into a busy wait.
    for _ in 0..32 {
        match mainloop.iterate(false) {
            pulse::mainloop::standard::IterateResult::Success(0) => break,
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => bail!(AUDIO_UNAVAILABLE),
        }
        if started.elapsed() >= Duration::from_millis(2) {
            break;
        }
    }
    Ok(())
}

struct PulseConnection {
    context: pulse::context::Context,
    mainloop: pulse::mainloop::standard::Mainloop,
    deadline: Instant,
}

impl PulseConnection {
    fn new() -> Result<Self> {
        Self::new_at(None)
    }

    fn new_at(server: Option<&str>) -> Result<Self> {
        let mainloop =
            pulse::mainloop::standard::Mainloop::new().ok_or_else(|| anyhow!(AUDIO_UNAVAILABLE))?;
        let server = server
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(local_server_address)?;
        validate_local_server(&server)?;
        let mut context = pulse::context::Context::new(&mainloop, "Kiri audio device check")
            .ok_or_else(|| anyhow!(AUDIO_UNAVAILABLE))?;
        context
            .connect(Some(&server), pulse::context::FlagSet::NOAUTOSPAWN, None)
            .map_err(|_| anyhow!(AUDIO_UNAVAILABLE))?;
        let mut connection = Self {
            context,
            mainloop,
            deadline: Instant::now() + DISCOVERY_TIMEOUT,
        };
        while connection.context.get_state() != pulse::context::State::Ready {
            connection.iterate()?;
        }
        if connection.context.is_local() != Some(true) {
            bail!("Kiri audio recording requires a local sound service.");
        }
        Ok(connection)
    }

    fn iterate(&mut self) -> Result<()> {
        if Instant::now() >= self.deadline
            || matches!(
                self.context.get_state(),
                pulse::context::State::Failed | pulse::context::State::Terminated
            )
        {
            bail!(AUDIO_UNAVAILABLE);
        }
        drain_mainloop(&mut self.mainloop)?;
        std::thread::sleep(Duration::from_millis(2));
        Ok(())
    }

    fn complete<T: ?Sized>(&mut self, mut operation: pulse::operation::Operation<T>) -> Result<()> {
        while operation.get_state() == pulse::operation::State::Running {
            if let Err(error) = self.iterate() {
                operation.cancel();
                return Err(error);
            }
        }
        if operation.get_state() != pulse::operation::State::Done {
            bail!(AUDIO_UNAVAILABLE);
        }
        Ok(())
    }
}

impl Drop for PulseConnection {
    fn drop(&mut self) {
        self.context.disconnect();
    }
}

/// Resolve defaults once per segment. A monitor is matched by the server's
/// monitor_of_sink metadata, never by its name, suffix or enumeration order.
pub fn selected_sources(system: bool, microphone: bool) -> Result<Vec<AudioSource>> {
    if !system && !microphone {
        return Ok(Vec::new());
    }
    if !supported() {
        bail!(AUDIO_UNAVAILABLE);
    }
    let mut connection = PulseConnection::new()?;
    let defaults = Rc::new(RefCell::new(None));
    let result = defaults.clone();
    let operation = connection
        .context
        .introspect()
        .get_server_info(move |info| {
            *result.borrow_mut() = Some((
                info.default_sink_name.as_deref().map(str::to_owned),
                info.default_source_name.as_deref().map(str::to_owned),
            ));
        });
    connection.complete(operation)?;
    let (sink, input) = defaults
        .borrow_mut()
        .take()
        .ok_or_else(|| anyhow!(AUDIO_UNAVAILABLE))?;
    let server = connection
        .context
        .get_server()
        .ok_or_else(|| anyhow!(AUDIO_UNAVAILABLE))?;
    let sources = Rc::new(RefCell::new(Vec::new()));
    let result = sources.clone();
    let operation = connection
        .context
        .introspect()
        .get_source_info_list(move |item| {
            if let pulse::callbacks::ListResult::Item(info) = item {
                if let Some(name) = info.name.as_deref() {
                    result.borrow_mut().push(AudioSource {
                        index: info.index,
                        server: server.clone(),
                        name: name.into(),
                        description: info.description.as_deref().unwrap_or(name).into(),
                        monitor_of: info.monitor_of_sink_name.as_deref().map(str::to_owned),
                        muted: info.mute,
                    });
                }
            }
        });
    connection.complete(operation)?;
    let result = select_sources(
        &sources.borrow(),
        sink.as_deref(),
        input.as_deref(),
        system,
        microphone,
    );
    result
}

fn select_sources(
    sources: &[AudioSource],
    sink: Option<&str>,
    input: Option<&str>,
    system: bool,
    microphone: bool,
) -> Result<Vec<AudioSource>> {
    let mut selected = Vec::new();
    if system {
        let monitor = sources
            .iter()
            .find(|source| sink.is_some() && source.monitor_of.as_deref() == sink)
            .ok_or_else(|| anyhow!(AUDIO_UNAVAILABLE))?;
        if monitor.muted {
            bail!(AUDIO_UNAVAILABLE);
        }
        selected.push(monitor.clone());
    }
    if microphone {
        let mic = sources
            .iter()
            .find(|source| Some(source.name.as_str()) == input && source.monitor_of.is_none())
            .ok_or_else(|| anyhow!(MICROPHONE_UNAVAILABLE))?;
        if mic.muted {
            bail!(MICROPHONE_UNAVAILABLE);
        }
        selected.push(mic.clone());
    }
    Ok(selected)
}

fn raw_sample_presentation_ns(snapshot_ns: i128, info: &pulse::def::TimingInfo) -> Result<i128> {
    if info.read_index_corrupt != 0 || info.write_index_corrupt != 0 {
        bail!(AUDIO_RECORDING_FAILED);
    }
    // A record read index already includes client-side unread bytes. The raw
    // snapshot avoids get_latency's UI smoother and startup zero clamping.
    // Keep both indices signed, and do not subtract transport latency again:
    // snapshot_ns is already mapped from the timestamp when this data was valid.
    Ok(snapshot_ns
        + (i128::from(info.read_index) - i128::from(info.write_index)) * 1_000_000_000
            / i128::from(PCM_BYTES_PER_SECOND)
        - i128::from(info.source_usec.0) * 1_000
        + i128::from(info.sink_usec.0) * 1_000)
}

#[derive(Default)]
struct NativeTiming {
    anchor: Option<(pulse::time::UnixTs, i128)>,
}

impl NativeTiming {
    fn sample_ns(
        &mut self,
        info: &pulse::def::TimingInfo,
        elapsed: Duration,
        now: pulse::time::UnixTs,
    ) -> Result<i128> {
        if info.timestamp > now {
            bail!(AUDIO_RECORDING_FAILED);
        }
        let age = pulse::time::UnixTs::diff(&now, &info.timestamp);
        if age.0 > 2_000_000 {
            bail!(AUDIO_RECORDING_FAILED);
        }
        if self
            .anchor
            .is_none_or(|(timestamp, _)| timestamp != info.timestamp)
        {
            self.anchor = Some((
                info.timestamp,
                elapsed.as_nanos() as i128 - i128::from(age.0) * 1_000,
            ));
        }
        raw_sample_presentation_ns(self.anchor.unwrap().1, info)
    }
}

fn bracketed_snapshot_elapsed(before: Duration, after: Duration) -> Result<Duration> {
    let span = after.checked_sub(before).context(AUDIO_RECORDING_FAILED)?;
    if span > Duration::from_millis(1) {
        bail!(AUDIO_RECORDING_FAILED);
    }
    Ok(before + span / 2)
}

fn recording_clock_pair(origin: Instant) -> Result<(Duration, pulse::time::UnixTs)> {
    for _ in 0..3 {
        let before = origin.elapsed();
        let now = pulse::time::UnixTs::now();
        if let Ok(elapsed) = bracketed_snapshot_elapsed(before, origin.elapsed()) {
            return Ok((elapsed, now));
        }
    }
    bail!(AUDIO_RECORDING_FAILED)
}

fn trim_pcm_before_origin(pts_ns: i128, bytes: &mut Vec<u8>) -> Duration {
    let skip_frames = if pts_ns < 0 {
        ((-pts_ns * 48_000 + 999_999_999) / 1_000_000_000) as usize
    } else {
        0
    };
    let skip_bytes = skip_frames.saturating_mul(8).min(bytes.len());
    bytes.drain(..skip_bytes);
    Duration::from_nanos(
        (pts_ns + skip_bytes as i128 * 1_000_000_000 / i128::from(PCM_BYTES_PER_SECOND)).max(0)
            as u64,
    )
}

fn validate_audio_continuity(previous_end: Option<Duration>, next: Duration) -> Result<()> {
    if previous_end.is_some_and(|expected| expected.abs_diff(next) > Duration::from_millis(100)) {
        bail!("{AUDIO_RECORDING_FAILED} [native timestamp discontinuity]");
    }
    Ok(())
}

fn pcm_bytes_before_cutoff(pts: Duration, cutoff: Duration, bytes: usize) -> usize {
    let frames = cutoff.saturating_sub(pts).as_nanos() * 48_000 / 1_000_000_000;
    bytes.min(
        usize::try_from(frames)
            .unwrap_or(usize::MAX)
            .saturating_mul(8),
    )
}

const PCM_BYTES_PER_SECOND: u64 = 48_000 * 2 * 4;
const PCM_QUEUE_BYTES: u64 = PCM_BYTES_PER_SECOND / 4;
// A monitor can deliver playback more than 250ms ahead (for example a 64KiB
// s16le FIFO sink). Keep that future PCM in libpulse until presentation time.
// Its native queue needs a separate, finite lead budget; appsrc/mixer queues
// remain at 250ms. Otherwise libpulse drops unread PCM before we can submit it.
const NATIVE_PCM_QUEUE_BYTES: u64 = PCM_BYTES_PER_SECOND;

struct NativeInput {
    stream: pulse::stream::Stream,
    source: AudioSource,
    next_pts: Option<Duration>,
    timing: NativeTiming,
    timing_ready: bool,
    timing_update: Option<pulse::operation::Operation<dyn FnMut(bool)>>,
    timing_result: Rc<std::cell::Cell<Option<bool>>>,
    last_data: Instant,
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct NativeTimingObservation {
    pub index: usize,
    pub source: String,
    pub is_monitor: bool,
    pub configured_source_us: u64,
    pub fragment_bytes: u32,
}

#[cfg(test)]
pub(crate) type NativeTimingObservations = Arc<Mutex<Vec<NativeTimingObservation>>>;

/// Explicit async libpulse capture avoids GStreamer's pulsesrc synchronous
/// open/flush waits. The mainloop is only iterated nonblocking on this worker.
/// Native overflow, holes, source movement and server failure all fail closed.
pub struct NativeCapture {
    #[cfg(test)]
    timing_observations: Option<NativeTimingObservations>,
    inputs: Vec<NativeInput>,
    connection: PulseConnection,
    failed: Rc<std::cell::Cell<bool>>,
}

impl NativeCapture {
    pub(crate) fn new(sources: &[AudioSource]) -> Result<Self> {
        let first = sources.first().context(AUDIO_UNAVAILABLE)?;
        let mut connection = PulseConnection::new_at(Some(&first.server))?;
        let failed = Rc::new(std::cell::Cell::new(false));
        let mut inputs = Vec::new();
        let spec = pulse::sample::Spec {
            format: pulse::sample::Format::F32le,
            channels: 2,
            rate: 48_000,
        };
        let attributes = pulse::def::BufferAttr {
            maxlength: NATIVE_PCM_QUEUE_BYTES as u32,
            fragsize: 3_840,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
        };
        for source in sources {
            let mut stream =
                pulse::stream::Stream::new(&mut connection.context, "Kiri recording", &spec, None)
                    .context(AUDIO_UNAVAILABLE)?;
            let overflow = failed.clone();
            stream.set_overflow_callback(Some(Box::new(move || overflow.set(true))));
            let moved = failed.clone();
            stream.set_moved_callback(Some(Box::new(move || moved.set(true))));
            stream
                .connect_record(
                    Some(&source.name),
                    Some(&attributes),
                    pulse::stream::FlagSet::START_CORKED
                        | pulse::stream::FlagSet::ADJUST_LATENCY
                        | pulse::stream::FlagSet::DONT_MOVE
                        | pulse::stream::FlagSet::AUTO_TIMING_UPDATE,
                )
                .map_err(|_| anyhow!(AUDIO_UNAVAILABLE))?;
            while stream.get_state() != pulse::stream::State::Ready {
                if matches!(
                    stream.get_state(),
                    pulse::stream::State::Failed | pulse::stream::State::Terminated
                ) {
                    bail!(AUDIO_UNAVAILABLE);
                }
                connection.iterate()?;
            }
            if stream.get_device_index() != Some(source.index)
                || stream.get_sample_spec() != Some(&spec)
                || stream.get_buffer_attr().is_none_or(|actual| {
                    actual.maxlength > NATIVE_PCM_QUEUE_BYTES as u32
                        || actual.fragsize > NATIVE_PCM_QUEUE_BYTES as u32
                })
            {
                bail!(AUDIO_UNAVAILABLE);
            }
            inputs.push(NativeInput {
                stream,
                source: source.clone(),
                next_pts: None,
                timing: NativeTiming::default(),
                timing_ready: false,
                timing_update: None,
                timing_result: Rc::new(std::cell::Cell::new(None)),
                last_data: Instant::now(),
            });
        }
        Ok(Self {
            #[cfg(test)]
            timing_observations: None,
            inputs,
            connection,
            failed,
        })
    }

    pub fn start(&mut self) -> Result<()> {
        self.connection.deadline = Instant::now() + DISCOVERY_TIMEOUT;
        let operations = self
            .inputs
            .iter_mut()
            .map(|input| {
                let failed = self.failed.clone();
                input.last_data = Instant::now();
                input.stream.uncork(Some(Box::new(move |success| {
                    if !success {
                        failed.set(true);
                    }
                })))
            })
            .collect::<Vec<_>>();
        for operation in operations {
            self.connection.complete(operation)?;
        }
        // Timing immediately after uncork can still describe an idle source.
        // Each input requests its first usable snapshot only after real PCM
        // arrives, then waits for that reply asynchronously in pump().
        self.check()
    }

    pub fn finish(
        &mut self,
        origin: Instant,
        cutoff: Duration,
        mut consume: impl FnMut(usize, Vec<u8>, Duration, Duration) -> Result<()>,
    ) -> Result<()> {
        // Drain source latency only through the frozen video boundary. Future
        // monitor samples and post-stop microphone samples are never submitted.
        let deadline = Instant::now() + Duration::from_millis(500);
        let tolerance = Duration::from_nanos(1_000_000_000 / 48_000 + 1);
        while self
            .inputs
            .iter()
            .any(|input| input.next_pts.is_none_or(|end| end + tolerance < cutoff))
        {
            if Instant::now() >= deadline {
                bail!(AUDIO_RECORDING_FAILED);
            }
            self.pump(origin, Some(cutoff), &mut consume)?;
            std::thread::sleep(Duration::from_millis(2));
        }
        self.check()
    }

    fn check(&self) -> Result<()> {
        if self.failed.get() {
            bail!("{AUDIO_RECORDING_FAILED} [native overflow or device move]");
        }
        if self.connection.context.get_state() != pulse::context::State::Ready {
            bail!("{AUDIO_RECORDING_FAILED} [sound service disconnected]");
        }
        for input in &self.inputs {
            if input.stream.get_state() != pulse::stream::State::Ready
                || input.stream.get_device_index() != Some(input.source.index)
                || input.stream.is_suspended().unwrap_or(true)
                || input.last_data.elapsed() > Duration::from_secs(2)
            {
                bail!(AUDIO_RECORDING_FAILED);
            }
        }
        Ok(())
    }

    pub fn pump(
        &mut self,
        origin: Instant,
        cutoff: Option<Duration>,
        mut consume: impl FnMut(usize, Vec<u8>, Duration, Duration) -> Result<()>,
    ) -> Result<()> {
        // Refresh the read-only context deadline; no operation below waits for
        // server I/O. Server loss and stalled data have independent checks.
        self.connection.deadline = Instant::now() + DISCOVERY_TIMEOUT;
        self.connection
            .iterate()
            .map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?;
        self.check()?;
        for (index, input) in self.inputs.iter_mut().enumerate() {
            for _ in 0..128 {
                let queued = input
                    .stream
                    .readable_size()
                    .context(AUDIO_RECORDING_FAILED)? as u64;
                if queued > NATIVE_PCM_QUEUE_BYTES {
                    bail!(AUDIO_RECORDING_FAILED);
                }
                if queued == 0 {
                    break;
                }
                if !input.timing_ready {
                    match input
                        .timing_update
                        .as_ref()
                        .map(|update| update.get_state())
                    {
                        Some(pulse::operation::State::Done) => {
                            if input.timing_result.get() != Some(true) {
                                bail!(AUDIO_RECORDING_FAILED);
                            }
                            input.timing_update = None;
                            input.timing_ready = true;
                        }
                        Some(pulse::operation::State::Cancelled) => bail!(AUDIO_RECORDING_FAILED),
                        Some(pulse::operation::State::Running) => break,
                        None => {
                            let result = input.timing_result.clone();
                            input.timing_update = Some(input.stream.update_timing_info(Some(
                                Box::new(move |success| result.set(Some(success))),
                            )));
                            break;
                        }
                    }
                }
                let Some(info) = input.stream.get_timing_info().copied() else {
                    break;
                };
                let (elapsed, now) = recording_clock_pair(origin)?;
                #[cfg(test)]
                if input
                    .timing
                    .anchor
                    .is_none_or(|(stamp, _)| stamp != info.timestamp)
                {
                    let fragment_bytes = input
                        .stream
                        .get_buffer_attr()
                        .map(|attributes| attributes.fragsize)
                        .unwrap_or(0);
                    if let Some(observations) = &self.timing_observations {
                        observations.lock().unwrap().push(NativeTimingObservation {
                            index,
                            source: input.source.name.clone(),
                            is_monitor: input.source.monitor_of.is_some(),
                            configured_source_us: info.configured_source_usec.0,
                            fragment_bytes,
                        });
                    }
                    if std::env::var("KIRI_LINUX_PULSE_QA").as_deref() == Ok("1") {
                        eprintln!("kiri-audio-snapshot source={} elapsed_us={} read={} write={} source_us={} sink_us={} transport_us={} age_us={} timestamp={} queued_bytes={} configured_source_us={} configured_sink_us={} actual_fragsize={}", input.source.name, elapsed.as_micros(), info.read_index, info.write_index, info.source_usec.0, info.sink_usec.0, info.transport_usec.0, pulse::time::UnixTs::diff(&now, &info.timestamp).0, info.timestamp, queued, info.configured_source_usec.0, info.configured_sink_usec.0, fragment_bytes);
                    }
                }
                let raw_pts = input.timing.sample_ns(&info, elapsed, now)?;
                let measured = Duration::from_nanos(
                    u64::try_from(raw_pts.max(0)).map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?,
                );
                validate_audio_continuity(input.next_pts, measured)?;
                // Monitors can deliver future playback. Leave it unread until
                // presentation time, so stopping cannot include future sound.
                if cutoff.is_some_and(|cutoff| measured >= cutoff) {
                    input.next_pts = cutoff;
                    break;
                }
                if measured > elapsed {
                    break;
                }
                let mut bytes = match input
                    .stream
                    .peek()
                    .map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?
                {
                    pulse::stream::PeekResult::Data(bytes) => bytes.to_vec(),
                    pulse::stream::PeekResult::Empty => break,
                    pulse::stream::PeekResult::Hole(_) => bail!(AUDIO_RECORDING_FAILED),
                };
                if bytes.is_empty() || !bytes.len().is_multiple_of(8) {
                    bail!(AUDIO_RECORDING_FAILED);
                }
                let raw_duration =
                    bytes.len() as i128 * 1_000_000_000 / i128::from(PCM_BYTES_PER_SECOND);
                if cutoff.is_none() && raw_pts + raw_duration > elapsed.as_nanos() as i128 {
                    break;
                }
                let pts = trim_pcm_before_origin(raw_pts, &mut bytes);
                if bytes.is_empty() {
                    input
                        .stream
                        .discard()
                        .map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?;
                    input.last_data = Instant::now();
                    continue;
                }
                if let Some(cutoff) = cutoff {
                    bytes.truncate(pcm_bytes_before_cutoff(pts, cutoff, bytes.len()));
                    if bytes.is_empty() {
                        input.next_pts = Some(cutoff);
                        break;
                    }
                }
                let duration =
                    Duration::from_nanos(bytes.len() as u64 * 1_000_000_000 / PCM_BYTES_PER_SECOND);
                // Timestamp correction is tied to native snapshots, not worker
                // polling delays. audiorate handles bounded device clock drift;
                // the native continuity check rejects large discontinuities.
                input.next_pts = Some(pts + duration);
                input
                    .stream
                    .discard()
                    .map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?;
                input.last_data = Instant::now();
                consume(index, bytes, pts, duration)?;
            }
        }
        self.check()
    }
}

impl Drop for NativeCapture {
    fn drop(&mut self) {
        // disconnect queues teardown without flushing or waiting for a server
        // acknowledgement; callbacks and streams die before the mainloop.
        for input in &mut self.inputs {
            if let Some(mut update) = input.timing_update.take() {
                update.cancel();
            }
            let _ = input.stream.disconnect();
        }
    }
}

pub struct RecordingAudio {
    #[cfg(test)]
    timing_observations: Option<NativeTimingObservations>,
    devices: Vec<AudioSource>,
    sources: Vec<gstreamer::Element>,
    progress: Vec<Arc<Mutex<Option<Instant>>>>,
    failed: Arc<AtomicBool>,
    samples: Vec<Arc<AtomicU64>>,
}

impl RecordingAudio {
    /// All identifiers in this description are generated locally. Device names
    /// are assigned as properties afterward, never interpolated into a parser.
    pub fn description(count: usize, source: &str) -> String {
        if count == 0 {
            return String::new();
        }
        // appsrc cannot report native hardware/transport latency. Reserve the
        // same bounded 250ms window as capture, otherwise a live mixer emits
        // silence before correctly timestamped native PCM reaches its pad.
        let mut description = String::from(" audiomixer name=audio_mix latency=250000000 ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ! avenc_aac bitrate=192000 ! aacparse ! queue max-size-buffers=0 max-size-bytes=262144 max-size-time=250000000 ! mux.audio_0");
        for index in 0..count {
            description.push_str(&format!(" {source} name=audio_{index} ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ! audiorate tolerance=20000000 skip-to-first=true ! queue name=audio_queue_{index} max-size-buffers=0 max-size-bytes=96000 max-size-time=250000000 ! audio_mix."));
        }
        description
    }

    pub fn attach(pipeline: &gstreamer::Pipeline, sources: &[AudioSource]) -> Result<Self> {
        let mut audio = Self::observe(pipeline, sources.len())?;
        audio.devices = sources.to_vec();
        for source in &audio.sources {
            let appsrc = source
                .clone()
                .downcast::<gstreamer_app::AppSrc>()
                .map_err(|_| anyhow!(AUDIO_UNAVAILABLE))?;
            appsrc.set_max_bytes(PCM_QUEUE_BYTES);
            appsrc.set_block(false);
        }
        Ok(audio)
    }

    pub fn observe(pipeline: &gstreamer::Pipeline, count: usize) -> Result<Self> {
        let failed = Arc::new(AtomicBool::new(false));
        let mut sources = Vec::new();
        let mut progress = Vec::new();
        let mut samples = Vec::new();
        for index in 0..count {
            let source = pipeline
                .by_name(&format!("audio_{index}"))
                .context("Missing audio source")?;
            let queue = pipeline
                .by_name(&format!("audio_queue_{index}"))
                .context("Missing audio queue")?;
            let overloaded = failed.clone();
            queue.connect("overrun", false, move |_| {
                overloaded.store(true, Ordering::Release);
                None
            });
            let last = Arc::new(Mutex::new(None));
            let count = Arc::new(AtomicU64::new(0));
            let update = last.clone();
            let counter = count.clone();
            let discontinuity = failed.clone();
            queue
                .static_pad("sink")
                .context("Missing audio queue pad")?
                .add_probe(gstreamer::PadProbeType::BUFFER, move |_, info| {
                    if let Some(buffer) = info.buffer() {
                        let previous = counter.fetch_add(1, Ordering::AcqRel);
                        if previous > 0 && buffer.flags().contains(gstreamer::BufferFlags::DISCONT)
                        {
                            discontinuity.store(true, Ordering::Release);
                        }
                        *update
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(Instant::now());
                    }
                    gstreamer::PadProbeReturn::Ok
                });
            sources.push(source);
            progress.push(last);
            samples.push(count);
        }
        Ok(Self {
            #[cfg(test)]
            timing_observations: None,
            devices: Vec::new(),
            sources,
            progress,
            failed,
            samples,
        })
    }

    #[cfg(test)]
    pub fn observe_native_timing(&mut self, observations: NativeTimingObservations) {
        self.timing_observations = Some(observations);
    }

    pub fn prepare_native(&self) -> Result<Option<NativeCapture>> {
        if self.devices.is_empty() {
            Ok(None)
        } else {
            let capture = NativeCapture::new(&self.devices)?;
            #[cfg(test)]
            let capture = {
                let mut capture = capture;
                capture.timing_observations = self.timing_observations.clone();
                capture
            };
            Ok(Some(capture))
        }
    }

    pub fn push(
        &self,
        index: usize,
        bytes: Vec<u8>,
        pts: Duration,
        duration: Duration,
    ) -> Result<()> {
        let appsrc = self.sources[index]
            .clone()
            .downcast::<gstreamer_app::AppSrc>()
            .map_err(|_| anyhow!(AUDIO_RECORDING_FAILED))?;
        if appsrc.current_level_bytes() + bytes.len() as u64 > PCM_QUEUE_BYTES {
            bail!(AUDIO_RECORDING_FAILED);
        }
        let mut buffer = gstreamer::Buffer::from_mut_slice(bytes);
        {
            let buffer = buffer.get_mut().context(AUDIO_RECORDING_FAILED)?;
            buffer.set_pts(gstreamer::ClockTime::from_nseconds(pts.as_nanos() as u64));
            buffer.set_duration(gstreamer::ClockTime::from_nseconds(
                duration.as_nanos() as u64
            ));
        }
        appsrc.push_buffer(buffer).context(AUDIO_RECORDING_FAILED)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.failed.load(Ordering::Acquire)
            || self
                .samples
                .iter()
                .any(|count| count.load(Ordering::Acquire) == 0)
        {
            bail!(AUDIO_RECORDING_FAILED);
        }
        Ok(())
    }

    pub fn is_enabled(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn check(&self, started: Instant) -> Result<()> {
        if self.failed.load(Ordering::Acquire) {
            bail!(AUDIO_RECORDING_FAILED);
        }
        for last in &self.progress {
            let last = *last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if last.unwrap_or(started).elapsed() > Duration::from_secs(2) {
                bail!(AUDIO_RECORDING_FAILED);
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<()> {
        for source in &self.sources {
            if let Ok(appsrc) = source.clone().downcast::<gstreamer_app::AppSrc>() {
                appsrc.end_of_stream().context(AUDIO_RECORDING_FAILED)?;
            } else if !source.send_event(gstreamer::event::Eos::new()) {
                bail!(AUDIO_RECORDING_FAILED);
            }
        }
        Ok(())
    }
}

/// Same resolved non-monitor source as recording; no PCM is written to disk.
pub fn microphone_check(
    mut current: impl FnMut() -> bool,
    mut level: impl FnMut(String, f32) -> Result<()>,
) -> Result<()> {
    if !current() {
        return Ok(());
    }
    let source = selected_sources(false, true)?
        .pop()
        .context(MICROPHONE_UNAVAILABLE)?;
    let mut capture = NativeCapture::new(std::slice::from_ref(&source))?;
    if !current() {
        return Ok(());
    }
    let started = Instant::now();
    capture.start()?;
    let mut peak = 0.0f32;
    let mut last_meter = Instant::now();
    while current() && started.elapsed() < Duration::from_secs(5) {
        capture.pump(started, None, |_, bytes, _, _| {
            for chunk in bytes.as_chunks::<4>().0 {
                let value = f32::from_le_bytes(*chunk);
                if value.is_finite() {
                    peak = peak.max(value.abs());
                }
            }
            Ok(())
        })?;
        if last_meter.elapsed() >= Duration::from_millis(100) {
            level(source.description.clone(), peak)?;
            peak = 0.0;
            last_meter = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(name: &str, monitor: Option<&str>) -> AudioSource {
        AudioSource {
            name: name.into(),
            index: 0,
            server: "unix:synthetic-test-only".into(),
            description: name.into(),
            monitor_of: monitor.map(str::to_owned),
            muted: false,
        }
    }
    #[test]
    fn ready_transport_work_cannot_starve_pulse_timers() {
        use pulse::mainloop::api::Mainloop as _;
        let mut mainloop = pulse::mainloop::standard::Mainloop::new().unwrap();
        let fired = Rc::new(std::cell::Cell::new(false));
        let result = fired.clone();
        let _timer = mainloop
            .new_timer_event(
                &pulse::time::UnixTs::now(),
                Box::new(move |_| result.set(true)),
            )
            .unwrap();
        let mut transport = mainloop
            .new_deferred_event(Box::new(|mut event| event.disable()))
            .unwrap();
        assert!(mainloop.iterate(false).is_success());
        assert!(
            !fired.get(),
            "one iteration only processed the transport defer"
        );
        // Releasing the just-consumed PCM re-enables deferred transport work.
        let deadline = Instant::now() + Duration::from_secs(1);
        while !fired.get() && Instant::now() < deadline {
            transport.enable();
            drain_mainloop(&mut mainloop).unwrap();
        }
        assert!(
            fired.get(),
            "the ready timer must run before the next PCM batch"
        );
    }

    #[test]
    fn audio_never_connects_to_network_or_ambiguous_servers() {
        assert!(validate_local_server("unix:/run/user/1000/pulse/native").is_ok());
        assert!(validate_local_server("/tmp/private-pulse/native").is_ok());
        for server in [
            "tcp:host",
            "host",
            "unix:/tmp/socket tcp:host",
            "{host}unix:/tmp/socket",
            "unix:relative",
        ] {
            assert!(validate_local_server(server).is_err());
        }
    }

    fn timing_info() -> pulse::def::TimingInfo {
        pulse::def::TimingInfo {
            timestamp: pulse::time::UnixTs::now(),
            synchronized_clocks: 1,
            sink_usec: pulse::time::MicroSeconds(0),
            source_usec: pulse::time::MicroSeconds(0),
            transport_usec: pulse::time::MicroSeconds(5_000),
            playing: 1,
            write_index_corrupt: 0,
            write_index: 38_400,
            read_index_corrupt: 0,
            read_index: 30_720,
            configured_sink_usec: pulse::time::MicroSeconds(0),
            configured_source_usec: pulse::time::MicroSeconds(0),
            since_underrun: 0,
        }
    }

    #[test]
    fn native_timestamps_use_signed_snapshot_positions_not_poll_delays() {
        let mut info = timing_info();
        let snapshot = 100_000_000;
        let mut timing = NativeTiming::default();
        let mut now = info.timestamp + pulse::time::MicroSeconds(10_000);
        assert_eq!(
            timing
                .sample_ns(&info, Duration::from_millis(110), now)
                .unwrap(),
            80_000_000
        );
        now += pulse::time::MicroSeconds(27_000);
        assert_eq!(
            timing
                .sample_ns(&info, Duration::from_millis(137), now)
                .unwrap(),
            80_000_000
        );
        let mut refreshed = info;
        refreshed.timestamp += pulse::time::MicroSeconds(20_000);
        refreshed.write_index += 7_680;
        assert_eq!(
            timing
                .sample_ns(&refreshed, Duration::from_millis(137), now)
                .unwrap(),
            80_000_000
        );
        assert_eq!(
            raw_sample_presentation_ns(snapshot, &info).unwrap(),
            80_000_000
        );
        // Reusing a snapshot does not advance its clock by the 27ms between
        // worker polls. Only consuming exactly 10ms of PCM advances by 10ms.
        assert_eq!(
            raw_sample_presentation_ns(snapshot, &info).unwrap(),
            80_000_000
        );
        info.read_index += 3_840;
        assert_eq!(
            raw_sample_presentation_ns(snapshot, &info).unwrap(),
            90_000_000
        );
        info.source_usec = pulse::time::MicroSeconds(5_000);
        info.sink_usec = pulse::time::MicroSeconds(35_000);
        assert_eq!(
            raw_sample_presentation_ns(snapshot, &info).unwrap(),
            120_000_000
        );
        info.read_index = -3_840;
        info.write_index = 0;
        assert_eq!(raw_sample_presentation_ns(0, &info).unwrap(), 20_000_000);
        info.sink_usec = pulse::time::MicroSeconds(0);
        assert_eq!(raw_sample_presentation_ns(0, &info).unwrap(), -15_000_000);
        info.read_index_corrupt = 1;
        assert!(raw_sample_presentation_ns(snapshot, &info).is_err());
    }

    #[test]
    fn snapshot_clock_pair_rejects_scheduler_delay() {
        assert_eq!(
            bracketed_snapshot_elapsed(Duration::from_micros(100), Duration::from_micros(120))
                .unwrap(),
            Duration::from_micros(110)
        );
        assert!(bracketed_snapshot_elapsed(Duration::ZERO, Duration::from_millis(27)).is_err());
    }

    #[test]
    fn corrupt_stale_and_future_native_snapshots_fail_closed() {
        let mut info = timing_info();
        let now = info.timestamp;
        info.write_index_corrupt = 1;
        assert!(NativeTiming::default()
            .sample_ns(&info, Duration::ZERO, now)
            .is_err());
        info.write_index_corrupt = 0;
        assert!(NativeTiming::default()
            .sample_ns(
                &info,
                Duration::ZERO,
                now + pulse::time::MicroSeconds(2_000_001)
            )
            .is_err());
        assert!(NativeTiming::default()
            .sample_ns(&info, Duration::ZERO, now - pulse::time::MicroSeconds(1))
            .is_err());
    }

    #[test]
    fn signed_start_trim_and_stop_cutoff_preserve_monitor_timing() {
        let now = Duration::from_millis(100);
        let mut samples = vec![1; 7_680];
        assert_eq!(
            trim_pcm_before_origin(-10_000_000, &mut samples),
            Duration::ZERO
        );
        assert_eq!(samples.len(), 3_840);
        let mut partial = vec![1; 16];
        assert_eq!(
            trim_pcm_before_origin(-1, &mut partial),
            Duration::from_nanos(20_832)
        );
        assert_eq!(partial.len(), 8);
        assert_eq!(
            trim_pcm_before_origin(-20_000_000, &mut samples),
            Duration::ZERO
        );
        assert!(samples.is_empty());
        assert_eq!(
            pcm_bytes_before_cutoff(Duration::from_millis(90), now, 7680),
            3840
        );
        assert_eq!(
            pcm_bytes_before_cutoff(Duration::from_millis(120), now, 7680),
            0
        );
        assert_eq!(
            pcm_bytes_before_cutoff(Duration::from_millis(80), now, 3840),
            3840
        );
    }

    #[test]
    fn final_cutoff_cannot_hide_a_forward_clock_jump() {
        assert!(validate_audio_continuity(
            Some(Duration::from_millis(500)),
            Duration::from_millis(1100)
        )
        .is_err());
        assert!(validate_audio_continuity(
            Some(Duration::from_millis(500)),
            Duration::from_millis(510)
        )
        .is_ok());
        assert!(validate_audio_continuity(None, Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn selection_never_substitutes_default_input_for_output_monitor() {
        let sources = [
            source("mic", None),
            source("arbitrary monitor name", Some("speakers")),
            source("other.monitor", Some("headphones")),
        ];
        assert_eq!(
            select_sources(&sources, Some("speakers"), Some("mic"), true, false).unwrap()[0].name,
            "arbitrary monitor name"
        );
        assert_eq!(
            select_sources(&sources, Some("speakers"), Some("mic"), false, true).unwrap()[0].name,
            "mic"
        );
        assert_eq!(
            select_sources(&sources, Some("speakers"), Some("mic"), true, true)
                .unwrap()
                .len(),
            2
        );
        assert!(select_sources(&sources, Some("missing"), Some("mic"), true, false).is_err());
        assert!(select_sources(
            &sources,
            Some("speakers"),
            Some("other.monitor"),
            false,
            true
        )
        .is_err());
    }
    #[test]
    fn muted_or_absent_input_is_not_silently_recorded() {
        let mut mic = source("mic", None);
        mic.muted = true;
        assert!(select_sources(&[mic], None, Some("mic"), false, true).is_err());
        assert!(select_sources(&[], None, None, false, true).is_err());
        assert!(selected_sources(false, false).unwrap().is_empty());
        assert!(RecordingAudio::description(0, "pulsesrc").is_empty());
    }
}
