//! UI state contains only bindings confirmed by the current portal session.
use serde::Serialize;

pub const APP_ID: &str = "io.yuxino.kiri";
pub const ACTIONS: [(&str, &str, &str); 3] = [
    ("capture", "Capture", "kiri --capture"),
    (
        "pause-resume",
        "Pause/Resume Recording",
        "kiri --toggle-recording-pause",
    ),
    ("stop", "Stop Recording", "kiri --stop-recording"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Unsupported,
    #[cfg(any(target_os = "linux", test))]
    Checking,
    #[cfg(any(target_os = "linux", test))]
    Unavailable,
    #[cfg(any(target_os = "linux", test))]
    Ready,
    #[cfg(any(target_os = "linux", test))]
    Connecting,
    #[cfg(any(target_os = "linux", test))]
    Active,
    #[cfg(any(target_os = "linux", test))]
    Declined,
    #[cfg(any(target_os = "linux", test))]
    Failed,
    #[cfg(any(target_os = "linux", test))]
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub description: String,
    pub command: String,
    pub trigger: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub status: Status,
    pub available: bool,
    pub can_configure: bool,
    pub app_id: &'static str,
    pub bindings: Vec<Binding>,
}

impl Snapshot {
    pub fn new(status: Status) -> Self {
        Self {
            revision: 0,
            status,
            available: false,
            can_configure: false,
            app_id: APP_ID,
            bindings: ACTIONS
                .iter()
                .map(|(id, description, command)| Binding {
                    id: (*id).into(),
                    description: (*description).into(),
                    command: (*command).into(),
                    trigger: None,
                })
                .collect(),
        }
    }
}

// Non-Linux platforms report Unsupported; only the portal actor mutates bindings.
#[cfg(any(target_os = "linux", test))]
impl Snapshot {
    pub fn clear(&mut self, status: Status) {
        self.status = status;
        self.can_configure = false;
        for binding in &mut self.bindings {
            binding.trigger = None;
        }
    }

    pub fn apply(&mut self, shortcuts: Vec<(String, Option<String>)>, version: u32) {
        // Treat the result as a complete replacement, never retain omitted or
        // revoked actions. Unknown IDs cannot become commands.
        self.clear(Status::Active);
        self.available = true;
        self.can_configure = version >= 2;
        for binding in &mut self.bindings {
            let matching: Vec<_> = shortcuts
                .iter()
                .filter(|(id, _)| id == &binding.id)
                .collect();
            // A duplicate ID is malformed, not two usable bindings.
            if let [(_, Some(trigger))] = matching.as_slice() {
                if !trigger.trim().is_empty() {
                    binding.trigger = Some(trigger.clone());
                }
            }
        }
    }

    pub fn bound(&self, id: &str) -> bool {
        self.status == Status::Active
            && self
                .bindings
                .iter()
                .any(|binding| binding.id == id && binding.trigger.is_some())
    }

    pub fn any_bound(&self) -> bool {
        self.bindings
            .iter()
            .any(|binding| binding.trigger.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_results_and_revocations_replace_confirmed_bindings() {
        let mut state = Snapshot::new(Status::Ready);
        state.apply(
            vec![("capture".into(), Some("Ctrl+A or Super+A".into()))],
            2,
        );
        assert!(state.bound("capture"));
        assert!(!state.bound("stop"));
        assert_eq!(
            state.bindings[0].trigger.as_deref(),
            Some("Ctrl+A or Super+A")
        );
        state.apply(vec![("stop".into(), Some("Ctrl+S".into()))], 1);
        assert!(!state.bound("capture"));
        assert!(state.bound("stop"));
        assert!(!state.can_configure);
        state.apply(vec![], 2);
        assert!(!state.any_bound());
    }
    #[test]
    fn empty_unknown_and_duplicate_bindings_never_activate() {
        let mut state = Snapshot::new(Status::Ready);
        state.apply(
            vec![
                ("capture".into(), Some(" ".into())),
                ("stop".into(), Some("S".into())),
                ("stop".into(), Some("T".into())),
                ("arbitrary-command".into(), Some("Q".into())),
            ],
            2,
        );
        assert!(!state.any_bound());
        assert!(!state.bound("arbitrary-command"));
    }
    #[test]
    fn fail_closed_on_every_nonactive_transition() {
        for status in [
            Status::Checking,
            Status::Unavailable,
            Status::Ready,
            Status::Connecting,
            Status::Declined,
            Status::Failed,
            Status::Closed,
        ] {
            let mut state = Snapshot::new(Status::Ready);
            state.apply(vec![("capture".into(), Some("Ctrl+A".into()))], 2);
            state.clear(status);
            assert!(!state.bound("capture"));
            assert!(!state.any_bound());
            assert!(!state.can_configure);
        }
    }
    #[test]
    fn adding_bindings_after_empty_setup_or_revocation_restores_opt_in() {
        let mut state = Snapshot::new(Status::Ready);
        state.apply(vec![], 2);
        assert!(!state.any_bound());
        state.apply(vec![("stop".into(), Some("Ctrl+S".into()))], 2);
        assert!(state.any_bound());
        state.apply(vec![], 2);
        assert!(!state.any_bound());
        state.apply(vec![("capture".into(), Some("Ctrl+A".into()))], 2);
        assert!(state.any_bound());
    }
}
