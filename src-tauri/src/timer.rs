//! Pure timer domain model and state machine.
//!
//! This module deliberately has no dependency on Tauri, windows, or the system
//! clock. Every operation takes `now` as an explicit argument, which makes the
//! whole state machine directly unit-testable and keeps the notion of "current
//! time" at the edge of the system.
//!
//! Time is represented as absolute wall-clock epoch milliseconds rather than as
//! a countdown that gets decremented. A decrementing counter drifts whenever a
//! tick is delayed or missed; an absolute deadline stays correct no matter how
//! irregular the ticks are. That is what makes the timer survive UI throttling,
//! backgrounding, CPU scheduling delays and system sleep.

use serde::{Deserialize, Serialize};

/// Absolute wall-clock time in milliseconds since the Unix epoch.
///
/// Signed so that `deadline - now` arithmetic cannot underflow when a deadline
/// is already in the past (which is the normal case after waking from sleep).
pub type Millis = i64;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimerState {
    /// Reminders are off. No deadline is scheduled.
    Stopped,
    /// Counting down towards the next break.
    Running,
    /// Explicitly paused by the user. No break can trigger.
    Paused,
    /// A break is on screen and counting down.
    BreakActive,
}

/// The complete observable timer state, sent to the UI as-is.
///
/// The UI renders countdowns by interpolating against these deadlines locally,
/// so display smoothness is decoupled from how often the backend emits.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimerSnapshot {
    pub state: TimerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_break_at: Option<Millis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub break_ends_at: Option<Millis>,
}

/// Side effects a `tick` asks the host to perform.
///
/// The pure core never touches windows itself; it only reports what should
/// happen so that a window-management failure cannot corrupt timer state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimerEffect {
    ShowBreak,
    HideBreak,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Milliseconds left until `deadline`, clamped to zero once it has passed.
///
/// Part of the documented pure-helper surface and covered by tests. The
/// running app renders countdowns in the webview, so nothing in the Rust
/// binary calls it.
#[allow(dead_code)]
pub fn get_remaining_millis(deadline: Millis, now: Millis) -> Millis {
    (deadline - now).max(0)
}

/// Whether `deadline` has been reached. Reaching it exactly counts as expired.
pub fn is_expired(deadline: Millis, now: Millis) -> bool {
    now >= deadline
}

pub fn calculate_next_break(now: Millis, interval_seconds: u32) -> Millis {
    now + i64::from(interval_seconds) * 1000
}

pub fn calculate_break_end(now: Millis, break_duration_seconds: u32) -> Millis {
    now + i64::from(break_duration_seconds) * 1000
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/// The authoritative timer. Owned by the Rust side so that breaks keep firing
/// while the settings window is hidden or closed.
#[derive(Clone, Copy, Debug)]
pub struct Timer {
    state: TimerState,
    next_break_at: Option<Millis>,
    break_ends_at: Option<Millis>,
    interval_seconds: u32,
    break_duration_seconds: u32,
}

impl Timer {
    pub fn new(interval_seconds: u32, break_duration_seconds: u32) -> Self {
        Self {
            state: TimerState::Stopped,
            next_break_at: None,
            break_ends_at: None,
            interval_seconds,
            break_duration_seconds,
        }
    }

    pub fn snapshot(&self) -> TimerSnapshot {
        TimerSnapshot {
            state: self.state,
            next_break_at: self.next_break_at,
            break_ends_at: self.break_ends_at,
        }
    }

    pub fn state(&self) -> TimerState {
        self.state
    }

    /// Applies new durations.
    ///
    /// A changed interval only takes effect from the next scheduled interval
    /// onwards while `RUNNING`, so that nudging the slider does not repeatedly
    /// push the pending break further away or fire one instantly. Changing the
    /// break duration mid-break likewise does not move the current break's end.
    pub fn set_durations(&mut self, interval_seconds: u32, break_duration_seconds: u32) {
        self.interval_seconds = interval_seconds;
        self.break_duration_seconds = break_duration_seconds;
    }

    /// Begins a fresh interval: `nextBreakAt = now + interval`.
    pub fn start(&mut self, now: Millis) {
        self.state = TimerState::Running;
        self.next_break_at = Some(calculate_next_break(now, self.interval_seconds));
        self.break_ends_at = None;
    }

    /// Stops scheduling without changing settings. No break can trigger while
    /// paused, and the pending deadline is dropped entirely rather than frozen,
    /// because a resume always starts over.
    pub fn pause(&mut self) {
        self.state = TimerState::Paused;
        self.next_break_at = None;
        self.break_ends_at = None;
    }

    /// Resumes with a *fresh* interval. Time spent paused is intentionally not
    /// compensated for: the point of the app is a break every N minutes of use,
    /// so a resume should not immediately fire a break the user did not earn.
    pub fn resume(&mut self, now: Millis) {
        self.start(now);
    }

    /// Starts a break immediately using the configured break duration.
    pub fn start_manual_break(&mut self, now: Millis) {
        self.state = TimerState::BreakActive;
        self.break_ends_at = Some(calculate_break_end(now, self.break_duration_seconds));
        self.next_break_at = None;
    }

    /// A break that ran to its deadline. Starts a fresh interval, so a manual
    /// break also resets the countdown to the next automatic break.
    pub fn complete_break(&mut self, now: Millis) {
        self.start(now);
    }

    /// A break cut short with Esc. Treated as interrupted but, like a completed
    /// break, it starts a fresh interval rather than re-firing straight away.
    pub fn interrupt_break(&mut self, now: Millis) {
        self.start(now);
    }

    pub fn reset(&mut self) {
        self.state = TimerState::Stopped;
        self.next_break_at = None;
        self.break_ends_at = None;
    }

    /// Advances the machine to `now` and reports what the host should do.
    ///
    /// Safe to call at any frequency, including after a long gap. Because
    /// entering `BREAK_ACTIVE` clears `next_break_at`, a deadline that expired
    /// while the machine was not running produces exactly **one** break. Three
    /// intervals missed during a two-hour sleep still yield a single break on
    /// wake; missed breaks are never queued or caught up.
    pub fn tick(&mut self, now: Millis) -> Option<TimerEffect> {
        match self.state {
            TimerState::Running => {
                let deadline = self.next_break_at?;
                if is_expired(deadline, now) {
                    self.start_manual_break(now);
                    return Some(TimerEffect::ShowBreak);
                }
                None
            }
            TimerState::BreakActive => {
                let deadline = self.break_ends_at?;
                if is_expired(deadline, now) {
                    self.complete_break(now);
                    return Some(TimerEffect::HideBreak);
                }
                None
            }
            TimerState::Stopped | TimerState::Paused => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: Millis = 1_700_000_000_000;
    const INTERVAL: u32 = 1800; // 30 minutes
    const DURATION: u32 = 30; // 30 seconds

    fn timer() -> Timer {
        Timer::new(INTERVAL, DURATION)
    }

    // -- pure helpers -------------------------------------------------------

    #[test]
    fn remaining_counts_down_and_clamps_at_zero() {
        assert_eq!(get_remaining_millis(T0 + 5000, T0), 5000);
        assert_eq!(get_remaining_millis(T0, T0), 0);
        assert_eq!(get_remaining_millis(T0 - 90_000, T0), 0);
    }

    #[test]
    fn expiry_includes_the_exact_deadline() {
        assert!(!is_expired(T0 + 1, T0));
        assert!(is_expired(T0, T0));
        assert!(is_expired(T0 - 1, T0));
    }

    #[test]
    fn deadline_calculations_use_absolute_time() {
        assert_eq!(calculate_next_break(T0, 60), T0 + 60_000);
        assert_eq!(calculate_break_end(T0, 30), T0 + 30_000);
    }

    // -- start / pause / resume --------------------------------------------

    #[test]
    fn start_schedules_one_interval_ahead() {
        let mut t = timer();
        assert_eq!(t.state(), TimerState::Stopped);
        t.start(T0);
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(t.snapshot().next_break_at, Some(T0 + 1_800_000));
        assert_eq!(t.snapshot().break_ends_at, None);
    }

    #[test]
    fn pause_prevents_the_next_break_from_triggering() {
        let mut t = timer();
        t.start(T0);
        t.pause();
        assert_eq!(t.state(), TimerState::Paused);
        assert_eq!(t.snapshot().next_break_at, None);
        // Long past the original deadline, nothing fires.
        assert_eq!(t.tick(T0 + 10_000_000), None);
        assert_eq!(t.state(), TimerState::Paused);
    }

    #[test]
    fn resume_starts_a_fresh_interval_without_crediting_paused_time() {
        let mut t = timer();
        t.start(T0);
        t.pause();
        let resumed_at = T0 + 9_999_999;
        t.resume(resumed_at);
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(
            t.snapshot().next_break_at,
            Some(resumed_at + 1_800_000),
            "resume must not fire immediately just because the old deadline passed"
        );
    }

    #[test]
    fn reset_returns_to_stopped_with_no_deadlines() {
        let mut t = timer();
        t.start(T0);
        t.reset();
        assert_eq!(t.state(), TimerState::Stopped);
        assert_eq!(t.snapshot().next_break_at, None);
        assert_eq!(t.snapshot().break_ends_at, None);
        assert_eq!(t.tick(T0 + 10_000_000), None);
    }

    // -- expiration and the break lifecycle --------------------------------

    #[test]
    fn tick_before_the_deadline_does_nothing() {
        let mut t = timer();
        t.start(T0);
        assert_eq!(t.tick(T0 + 1_799_999), None);
        assert_eq!(t.state(), TimerState::Running);
    }

    #[test]
    fn reaching_the_deadline_shows_a_break_and_schedules_its_end() {
        let mut t = timer();
        t.start(T0);
        let fired_at = T0 + 1_800_000;
        assert_eq!(t.tick(fired_at), Some(TimerEffect::ShowBreak));
        assert_eq!(t.state(), TimerState::BreakActive);
        assert_eq!(t.snapshot().break_ends_at, Some(fired_at + 30_000));
        assert_eq!(
            t.snapshot().next_break_at, None,
            "the interval deadline must be cleared so it cannot fire twice"
        );
    }

    #[test]
    fn completed_break_hides_and_starts_a_fresh_interval() {
        let mut t = timer();
        t.start(T0);
        t.tick(T0 + 1_800_000);
        let ended_at = T0 + 1_830_000;
        assert_eq!(t.tick(ended_at), Some(TimerEffect::HideBreak));
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(t.snapshot().next_break_at, Some(ended_at + 1_800_000));
        assert_eq!(t.snapshot().break_ends_at, None);
    }

    #[test]
    fn repeated_ticks_during_a_break_are_idempotent() {
        let mut t = timer();
        t.start(T0);
        t.tick(T0 + 1_800_000);
        for offset in [1, 5_000, 29_999] {
            assert_eq!(t.tick(T0 + 1_800_000 + offset), None);
            assert_eq!(t.state(), TimerState::BreakActive);
        }
    }

    // -- manual break -------------------------------------------------------

    #[test]
    fn manual_break_uses_the_configured_duration() {
        let mut t = timer();
        t.start(T0);
        let pressed_at = T0 + 60_000;
        t.start_manual_break(pressed_at);
        assert_eq!(t.state(), TimerState::BreakActive);
        assert_eq!(t.snapshot().break_ends_at, Some(pressed_at + 30_000));
        assert_eq!(t.snapshot().next_break_at, None);
    }

    #[test]
    fn completing_a_manual_break_resets_the_next_interval() {
        let mut t = timer();
        t.start(T0);
        t.start_manual_break(T0 + 60_000);
        let ended_at = T0 + 90_000;
        assert_eq!(t.tick(ended_at), Some(TimerEffect::HideBreak));
        assert_eq!(
            t.snapshot().next_break_at,
            Some(ended_at + 1_800_000),
            "the pre-existing deadline at T0+30min must not be resurrected"
        );
    }

    // -- interrupted break --------------------------------------------------

    #[test]
    fn interrupting_a_break_starts_a_fresh_interval() {
        let mut t = timer();
        t.start(T0);
        t.tick(T0 + 1_800_000);
        let escaped_at = T0 + 1_805_000;
        t.interrupt_break(escaped_at);
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(t.snapshot().next_break_at, Some(escaped_at + 1_800_000));
        assert_eq!(t.snapshot().break_ends_at, None);
        // The abandoned break must not re-fire at its old end time.
        assert_eq!(t.tick(escaped_at + 25_000), None);
    }

    // -- sleep / wake and missed deadlines ---------------------------------

    #[test]
    fn sleeping_through_one_deadline_fires_a_break_on_wake() {
        let mut t = timer();
        t.start(T0);
        // Slept past the 30-minute deadline and woke 100 minutes later.
        let woke_at = T0 + 6_000_000;
        assert_eq!(t.tick(woke_at), Some(TimerEffect::ShowBreak));
        assert_eq!(t.state(), TimerState::BreakActive);
        assert_eq!(
            t.snapshot().break_ends_at,
            Some(woke_at + 30_000),
            "the break duration is measured from wake, not from the missed deadline"
        );
    }

    #[test]
    fn sleeping_through_several_intervals_yields_exactly_one_break() {
        let mut t = timer();
        t.start(T0);
        // Three intervals' worth of sleep.
        let woke_at = T0 + 3 * 1_800_000 + 60_000;
        assert_eq!(t.tick(woke_at), Some(TimerEffect::ShowBreak));

        // Finish that single break, then confirm no backlog is waiting.
        let break_end = woke_at + 30_000;
        assert_eq!(t.tick(break_end), Some(TimerEffect::HideBreak));
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(t.tick(break_end + 1), None);
        assert_eq!(t.snapshot().next_break_at, Some(break_end + 1_800_000));
    }

    #[test]
    fn sleeping_through_an_active_break_ends_it_on_wake() {
        let mut t = timer();
        t.start(T0);
        t.tick(T0 + 1_800_000);
        // The machine slept for an hour mid-break; that counts as time away
        // from the screen, so the break is over rather than restarted.
        let woke_at = T0 + 1_800_000 + 3_600_000;
        assert_eq!(t.tick(woke_at), Some(TimerEffect::HideBreak));
        assert_eq!(t.state(), TimerState::Running);
        assert_eq!(t.snapshot().next_break_at, Some(woke_at + 1_800_000));
    }

    #[test]
    fn a_long_gap_between_ticks_does_not_drift() {
        let mut t = timer();
        t.start(T0);
        // One single tick 29 minutes late still lands correctly.
        assert_eq!(t.tick(T0 + 29 * 60_000), None);
        assert_eq!(t.tick(T0 + 30 * 60_000), Some(TimerEffect::ShowBreak));
    }

    // -- settings changes ---------------------------------------------------

    #[test]
    fn changing_durations_leaves_the_pending_deadline_alone() {
        let mut t = timer();
        t.start(T0);
        let original = t.snapshot().next_break_at;
        t.set_durations(900, 60);
        assert_eq!(t.snapshot().next_break_at, original);
        // The new interval applies to the interval after this one.
        t.tick(T0 + 1_800_000);
        assert_eq!(t.snapshot().break_ends_at, Some(T0 + 1_800_000 + 60_000));
        let ended = T0 + 1_800_000 + 60_000;
        t.tick(ended);
        assert_eq!(t.snapshot().next_break_at, Some(ended + 900_000));
    }
}
