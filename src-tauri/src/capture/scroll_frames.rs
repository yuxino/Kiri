//! Raw scrolling frames have their own byte-bounded queue. Encoder queues drop
//! the newest frame; stitching needs both chronological bridges and the latest
//! view, so overload instead thins the closest interior sample.
use std::collections::VecDeque;
use std::sync::mpsc::{RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const MAX_QUEUE_BYTES: usize = 96 * 1024 * 1024;
const MAX_QUEUE_FRAMES: usize = 8;

pub struct ScrollFrame {
    /// Tightly packed, top-left-origin BGRA pixels at native resolution.
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub sequence: u64,
    pub captured_at: Instant,
    /// Cumulative omitted frames when this frame leaves the queue.
    pub dropped_frames: u64,
}

struct State {
    frames: VecDeque<ScrollFrame>,
    bytes: usize,
    sequence: u64,
    dropped: u64,
    senders: usize,
    receiver_alive: bool,
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
    max_bytes: usize,
    max_frames: usize,
}

pub(crate) struct ScrollFrameSender(Arc<Shared>);
pub struct ScrollFrameReceiver(Arc<Shared>);

pub(crate) fn channel() -> (ScrollFrameSender, ScrollFrameReceiver) {
    bounded_channel(MAX_QUEUE_BYTES, MAX_QUEUE_FRAMES)
}

fn bounded_channel(
    max_bytes: usize,
    max_frames: usize,
) -> (ScrollFrameSender, ScrollFrameReceiver) {
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            frames: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            dropped: 0,
            senders: 1,
            receiver_alive: true,
        }),
        ready: Condvar::new(),
        max_bytes,
        max_frames,
    });
    (
        ScrollFrameSender(Arc::clone(&shared)),
        ScrollFrameReceiver(shared),
    )
}

impl ScrollFrameSender {
    /// Native callbacks never wait for consumer progress. Dimensions and buffer
    /// length must agree; invalid frames never become padded/corrupted evidence.
    pub(crate) fn send(
        &self,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
        captured_at: Instant,
    ) -> bool {
        let Some(stride) = (width as usize).checked_mul(4) else {
            return false;
        };
        let Some(expected) = stride.checked_mul(height as usize) else {
            return false;
        };
        if width == 0 || height == 0 || pixels.len() != expected || expected > self.0.max_bytes {
            return false;
        }
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if !state.receiver_alive {
            return false;
        }
        state.sequence += 1;
        let sequence = state.sequence;
        state.bytes += pixels.len();
        state.frames.push_back(ScrollFrame {
            pixels,
            width,
            height,
            stride,
            sequence,
            captured_at,
            dropped_frames: 0,
        });
        while state.frames.len() > self.0.max_frames || state.bytes > self.0.max_bytes {
            // Preserve oldest unread view and newest view whenever the budget
            // can hold both. Remove the most redundant temporal interior point.
            let index = if state.frames.len() > 2 {
                (1..state.frames.len() - 1)
                    .min_by_key(|&i| state.frames[i + 1].sequence - state.frames[i - 1].sequence)
                    .unwrap_or(1)
            } else {
                0
            };
            if let Some(removed) = state.frames.remove(index) {
                state.bytes -= removed.pixels.len();
                state.dropped += 1;
            }
        }
        self.0.ready.notify_one();
        true
    }
}

impl Clone for ScrollFrameSender {
    fn clone(&self) -> Self {
        self.0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .senders += 1;
        Self(Arc::clone(&self.0))
    }
}

impl Drop for ScrollFrameSender {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .senders -= 1;
        self.0.ready.notify_all();
    }
}

fn pop(state: &mut State) -> Option<ScrollFrame> {
    let mut frame = state.frames.pop_front()?;
    state.bytes -= frame.pixels.len();
    frame.dropped_frames = state.dropped;
    Some(frame)
}

impl ScrollFrameReceiver {
    pub fn try_recv(&self) -> Result<ScrollFrame, TryRecvError> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        pop(&mut state).ok_or(if state.senders == 0 {
            TryRecvError::Disconnected
        } else {
            TryRecvError::Empty
        })
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<ScrollFrame, RecvTimeoutError> {
        let state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        let (mut state, _) = self
            .0
            .ready
            .wait_timeout_while(state, timeout, |state| {
                state.frames.is_empty() && state.senders > 0
            })
            .unwrap_or_else(|p| p.into_inner());
        pop(&mut state).ok_or(if state.senders == 0 {
            RecvTimeoutError::Disconnected
        } else {
            RecvTimeoutError::Timeout
        })
    }
}

impl Drop for ScrollFrameReceiver {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        state.receiver_alive = false;
        state.frames.clear();
        state.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overload_retains_ordered_bridge_frames_and_latest_without_exceeding_budget() {
        let (tx, rx) = bounded_channel(5 * 12, 5);
        for _ in 0..40 {
            assert!(tx.send(vec![0; 12], 3, 1, Instant::now()));
        }
        let mut sequences = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            assert_eq!(frame.dropped_frames, 35);
            sequences.push(frame.sequence);
        }
        assert_eq!(sequences.len(), 5);
        assert_eq!(sequences[0], 1);
        assert_eq!(sequences[4], 40);
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            sequences[1] > 2,
            "retain temporal bridges, not only oldest adjacent frames"
        );
    }

    #[test]
    fn byte_budget_applies_independently_of_frame_limit() {
        let (tx, rx) = bounded_channel(24, 8);
        for _ in 0..10 {
            assert!(tx.send(vec![0; 12], 3, 1, Instant::now()));
        }
        assert_eq!(rx.try_recv().unwrap().sequence, 1);
        assert_eq!(rx.try_recv().unwrap().sequence, 10);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn odd_dimensions_are_preserved_and_invalid_frames_are_rejected() {
        let (tx, rx) = bounded_channel(100, 8);
        assert!(!tx.send(vec![0; 35], 3, 3, Instant::now()));
        assert!(!tx.send(vec![0; 104], 26, 1, Instant::now()));
        assert!(tx.send(vec![7; 36], 3, 3, Instant::now()));
        let frame = rx.try_recv().unwrap();
        assert_eq!((frame.width, frame.height, frame.stride), (3, 3, 12));
        assert_eq!(frame.pixels, vec![7; 36]);
    }

    #[test]
    fn shutdown_drains_frames_and_disconnects_after_last_sender() {
        let (tx, rx) = bounded_channel(100, 8);
        let cloned = tx.clone();
        tx.send(vec![0; 4], 1, 1, Instant::now());
        drop(tx);
        assert!(rx.try_recv().is_ok());
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Err(RecvTimeoutError::Timeout)
        ));
        drop(cloned);
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Err(RecvTimeoutError::Disconnected)
        ));
    }
}
