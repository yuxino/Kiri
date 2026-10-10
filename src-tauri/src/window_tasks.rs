//! WebView2 creation must run outside Windows IPC and native event callbacks.
//! One worker preserves presentation order and prevents two requests from
//! simultaneously creating the same resident confirmation/feedback window.

#[cfg(any(windows, test))]
type Task = Box<dyn FnOnce() + Send + 'static>;

#[cfg(any(windows, test))]
struct WindowTasks(std::sync::mpsc::Sender<Task>);

#[cfg(any(windows, test))]
impl WindowTasks {
    fn new() -> Result<Self, String> {
        let (sender, receiver) = std::sync::mpsc::channel::<Task>();
        std::thread::Builder::new()
            .name("kiri-window-tasks".into())
            .spawn(move || {
                for task in receiver {
                    task();
                }
            })
            .map_err(|error| format!("The window worker could not start: {error}"))?;
        Ok(Self(sender))
    }

    fn submit(&self, task: impl FnOnce() + Send + 'static) -> Result<(), String> {
        self.0
            .send(Box::new(task))
            .map_err(|_| "The window worker stopped.".to_string())
    }
}

#[cfg(windows)]
pub(crate) fn dispatch(task: impl FnOnce() + Send + 'static) -> Result<(), String> {
    static TASKS: std::sync::OnceLock<Result<WindowTasks, String>> = std::sync::OnceLock::new();
    match TASKS.get_or_init(WindowTasks::new) {
        Ok(tasks) => tasks.submit(task),
        Err(error) => Err(error.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn submission_returns_while_window_task_waits_for_the_event_loop() {
        let tasks = WindowTasks::new().unwrap();
        let caller = std::thread::current().id();
        let (release, event_loop) = mpsc::channel();
        let (done, result) = mpsc::channel();
        tasks
            .submit(move || {
                assert_ne!(std::thread::current().id(), caller);
                event_loop.recv_timeout(Duration::from_secs(5)).unwrap();
                done.send(()).unwrap();
            })
            .unwrap();
        // A callback must be free to return before native creation completes.
        assert!(result.try_recv().is_err());
        release.send(()).unwrap();
        result.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn resident_window_requests_finish_in_submission_order() {
        let tasks = WindowTasks::new().unwrap();
        let (release, first) = mpsc::channel();
        let (done, result) = mpsc::channel();
        let first_done = done.clone();
        tasks
            .submit(move || {
                first.recv_timeout(Duration::from_secs(5)).unwrap();
                first_done.send("create").unwrap();
            })
            .unwrap();
        tasks
            .submit(move || {
                done.send("update").unwrap();
            })
            .unwrap();
        assert!(result.try_recv().is_err());
        release.send(()).unwrap();
        assert_eq!(
            result.recv_timeout(Duration::from_secs(5)).unwrap(),
            "create"
        );
        assert_eq!(
            result.recv_timeout(Duration::from_secs(5)).unwrap(),
            "update"
        );
    }
}
