//! Keep recording backpressure separate from scrolling screenshot freshness.
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

pub(crate) enum NativeFrameSender {
    Recording(super::VideoFrameSender),
    Scrolling(ScrollFrameSender),
}

impl NativeFrameSender {
    pub(crate) fn try_send(&self, frame: Vec<u8>) -> Result<(), mpsc::TrySendError<Vec<u8>>> {
        match self {
            Self::Recording(sender) => sender.try_send(frame),
            Self::Scrolling(sender) => sender.try_send(frame),
        }
    }
}

impl From<super::VideoFrameSender> for NativeFrameSender {
    fn from(sender: super::VideoFrameSender) -> Self {
        Self::Recording(sender)
    }
}

impl From<ScrollFrameSender> for NativeFrameSender {
    fn from(sender: ScrollFrameSender) -> Self {
        Self::Scrolling(sender)
    }
}

#[derive(Default)]
struct ScrollFrames {
    pending: VecDeque<Vec<u8>>,
    sender_closed: bool,
    receiver_closed: bool,
}

#[derive(Default)]
struct ScrollChannel {
    frames: Mutex<ScrollFrames>,
    available: Condvar,
}

/// A single native producer retains the earliest queued overlap and latest
/// viewport. Replacing the second frame bounds memory without losing the final
/// scroll when ScreenCaptureKit/WGC stops delivering after the desktop settles.
/// The receiver never holds the mutex while matching or encoding pixels.
pub(crate) struct ScrollFrameSender(Arc<ScrollChannel>);
pub(crate) struct ScrollFrameReceiver(Arc<ScrollChannel>);

pub(crate) fn scroll_frame_channel() -> (ScrollFrameSender, ScrollFrameReceiver) {
    let channel = Arc::new(ScrollChannel::default());
    (
        ScrollFrameSender(Arc::clone(&channel)),
        ScrollFrameReceiver(channel),
    )
}

impl ScrollFrameSender {
    pub(crate) fn try_send(&self, frame: Vec<u8>) -> Result<(), mpsc::TrySendError<Vec<u8>>> {
        let mut frames = self.0.frames.lock().unwrap();
        if frames.receiver_closed {
            return Err(mpsc::TrySendError::Disconnected(frame));
        }
        let replaced = if frames.pending.len() == 2 {
            frames.pending.pop_back()
        } else {
            None
        };
        frames.pending.push_back(frame);
        drop(frames);
        self.0.available.notify_one();
        // Releasing a large image must not hold the producer/consumer mutex.
        drop(replaced);
        Ok(())
    }
}

impl Drop for ScrollFrameSender {
    fn drop(&mut self) {
        self.0.frames.lock().unwrap().sender_closed = true;
        self.0.available.notify_one();
    }
}

impl ScrollFrameReceiver {
    pub(crate) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Vec<u8>, mpsc::RecvTimeoutError> {
        let frames = self.0.frames.lock().unwrap();
        let (mut frames, _) = self
            .0
            .available
            .wait_timeout_while(frames, timeout, |frames| {
                frames.pending.is_empty() && !frames.sender_closed
            })
            .unwrap();
        if let Some(frame) = frames.pending.pop_front() {
            Ok(frame)
        } else if frames.sender_closed {
            Err(mpsc::RecvTimeoutError::Disconnected)
        } else {
            Err(mpsc::RecvTimeoutError::Timeout)
        }
    }

    #[cfg(test)]
    pub(crate) fn try_recv(&self) -> Result<Vec<u8>, mpsc::RecvTimeoutError> {
        self.recv_timeout(Duration::ZERO)
    }
}

impl Drop for ScrollFrameReceiver {
    fn drop(&mut self) {
        let mut frames = self.0.frames.lock().unwrap();
        frames.receiver_closed = true;
        let pending = std::mem::take(&mut frames.pending);
        drop(frames);
        drop(pending);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrolling_full_queue_keeps_first_overlap_and_last_viewport() {
        let (sender, frames) = scroll_frame_channel();
        let sender = NativeFrameSender::from(sender);
        for frame in 0..100 {
            sender.try_send(vec![frame]).unwrap();
        }
        // No blocking producer and no subsequent frame is needed to recover the
        // latest viewport. Only the first and final allocations remain queued.
        assert_eq!(frames.try_recv().unwrap(), vec![0]);
        assert_eq!(frames.try_recv().unwrap(), vec![99]);
        assert_eq!(frames.try_recv(), Err(mpsc::RecvTimeoutError::Timeout));
        drop(sender);
        assert_eq!(frames.try_recv(), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn scrolling_disconnect_drains_pending_pixels_and_rejects_abandoned_receivers() {
        let (sender, frames) = scroll_frame_channel();
        sender.try_send(vec![1]).unwrap();
        drop(sender);
        assert_eq!(frames.try_recv().unwrap(), vec![1]);
        assert_eq!(frames.try_recv(), Err(mpsc::RecvTimeoutError::Disconnected));

        let (sender, frames) = scroll_frame_channel();
        drop(frames);
        assert_eq!(
            sender.try_send(vec![2]),
            Err(mpsc::TrySendError::Disconnected(vec![2]))
        );
    }

    #[test]
    fn recording_keeps_its_original_full_queue_policy_and_order() {
        let (sender, frames) = mpsc::sync_channel(super::super::VIDEO_FRAME_QUEUE_CAPACITY);
        let sender = NativeFrameSender::from(sender);
        sender.try_send(vec![1]).unwrap();
        sender.try_send(vec![2]).unwrap();
        assert_eq!(
            sender.try_send(vec![3]),
            Err(mpsc::TrySendError::Full(vec![3]))
        );
        assert_eq!(frames.try_recv().unwrap(), vec![1]);
        assert_eq!(frames.try_recv().unwrap(), vec![2]);
    }
}
