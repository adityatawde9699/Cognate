//! planner.rs — the deterministic, explainable day scheduler (Act 1).
//!
//! This is the engine, not an AI. Given a day's work hours, the tasks, and the
//! calendar's busy blocks, it places tasks into free time respecting deadlines,
//! priority, estimated duration, an energy curve, pinned blocks, and meetings —
//! then explains each placement in one line. It is a pure function over its
//! input (`plan`), so it's fast, offline, private, and unit-testable. The AI
//! layer only *enriches* (durations, energy, prose); it never decides.
//!
//! Times are minutes-from-midnight (e.g. 360 = 06:00) for a single date.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const DEFAULT_DURATION: u32 = 30;
const DEFAULT_WORK_START: u32 = 6 * 60; // 06:00
const DEFAULT_WORK_END: u32 = 23 * 60; // 23:00

fn default_energy() -> String { "med".into() }
fn default_priority() -> String { "medium".into() }

#[derive(Deserialize, Clone)]
pub struct PlanTask {
    pub id: String,
    // Sent by the frontend; reserved for richer rationale prose later.
    #[serde(default)]
    #[allow(dead_code)]
    pub title: String,
    #[serde(default)]
    pub duration_min: u32,
    #[serde(default = "default_energy")]
    pub energy: String, // "hi" | "med" | "lo"
    #[serde(default)]
    pub deadline: String, // "YYYY-MM-DD" or ""
    #[serde(default = "default_priority")]
    pub priority: String, // "high" | "medium" | "low"
    #[serde(default)]
    pub importance: u8,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pinned_start_min: Option<u32>,
}

#[derive(Deserialize, Clone)]
pub struct BusyBlock {
    pub start_min: u32,
    pub end_min: u32,
    #[serde(default)]
    pub title: String,
}

#[derive(Deserialize)]
pub struct PlanRequest {
    pub date: String, // plan date "YYYY-MM-DD"
    pub work_start_min: u32,
    pub work_end_min: u32,
    pub tasks: Vec<PlanTask>,
    #[serde(default)]
    pub busy: Vec<BusyBlock>,
    /// Act 4: a learned 24-entry hourly energy curve (0/1/2). When present it
    /// overrides the fixed circadian curve. Empty → use `energy_at`.
    #[serde(default)]
    pub energy_curve: Vec<u8>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Block {
    pub task_id: String,
    pub start_min: u32,
    pub end_min: u32,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Unscheduled {
    pub task_id: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
pub struct PlanResult {
    pub blocks: Vec<Block>,
    pub unscheduled: Vec<Unscheduled>,
}

fn energy_rank(e: &str) -> u8 {
    match e {
        "hi" => 2,
        "lo" => 0,
        _ => 1,
    }
}

fn priority_rank(p: &str) -> u8 {
    match p {
        "high" => 2,
        "low" => 0,
        _ => 1,
    }
}

/// A simple circadian energy curve: morning peak, post-lunch dip, steady PM.
fn energy_at(min: u32) -> u8 {
    match min / 60 {
        0..=11 => 2,  // morning peak
        12 => 1,      // lunch
        13..=14 => 0, // post-lunch dip
        _ => 1,       // steady afternoon/evening
    }
}

/// Energy rank at a minute-of-day: a learned curve (Act 4) when supplied, else
/// the fixed circadian one.
fn energy_at_curve(min: u32, curve: &[u8]) -> u8 {
    if curve.len() == 24 {
        curve[((min / 60) % 24) as usize]
    } else {
        energy_at(min)
    }
}

fn dur_of(t: &PlanTask) -> u32 {
    if t.duration_min == 0 { DEFAULT_DURATION } else { t.duration_min }
}

/// Normalize a deadline for chronological sort; empty (no deadline) sorts last.
fn deadline_key(d: &str) -> String {
    if d.is_empty() { "9999-12-31".into() } else { d.to_string() }
}

/// Free intervals inside [ws, we] once `occupied` (busy + pinned) is removed.
fn free_windows(ws: u32, we: u32, occupied: &[(u32, u32)]) -> Vec<(u32, u32)> {
    if we <= ws {
        return vec![];
    }
    let mut occ: Vec<(u32, u32)> = occupied
        .iter()
        .map(|&(s, e)| (s.clamp(ws, we), e.clamp(ws, we)))
        .filter(|&(s, e)| e > s)
        .collect();
    occ.sort();

    // Merge overlapping/adjacent busy intervals.
    let mut merged: Vec<(u32, u32)> = Vec::new();
    for (s, e) in occ {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    // Gaps between merged busy intervals are the free windows.
    let mut free = Vec::new();
    let mut cursor = ws;
    for (s, e) in merged {
        if s > cursor {
            free.push((cursor, s));
        }
        cursor = cursor.max(e);
    }
    if cursor < we {
        free.push((cursor, we));
    }
    free
}

fn cap_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn reason_for(task: &PlanTask, start: u32, date: &str, busy: &[BusyBlock], curve: &[u8]) -> String {
    let mut parts: Vec<String> = Vec::new();

    if !task.deadline.is_empty() {
        if task.deadline.as_str() < date {
            parts.push("overdue".into());
        } else if task.deadline == date {
            parts.push("due today".into());
        }
    }
    if priority_rank(&task.priority) == 2 {
        parts.push("high priority".into());
    }
    // Energy match: a high-energy task landing in a peak window is intentional.
    if energy_rank(&task.energy) == 2 && energy_at_curve(start, curve) == 2 {
        parts.push("scheduled when your energy peaks".into());
    } else if energy_rank(&task.energy) == 0 && energy_at_curve(start, curve) == 0 {
        parts.push("low-energy work for a quieter hour".into());
    }
    // Slotted right after a meeting?
    if let Some(b) = busy.iter().find(|b| b.end_min == start) {
        let what = if b.title.is_empty() { "your calendar block".into() } else { format!("\"{}\"", b.title) };
        parts.push(format!("right after {what}"));
    }

    if parts.is_empty() {
        "Best available slot".into()
    } else {
        cap_first(&parts.join(", "))
    }
}

/// The scheduler. Pure: same input → same output.
pub fn plan(req: &PlanRequest) -> PlanResult {
    let (ws, we) = (req.work_start_min, req.work_end_min);
    let mut blocks: Vec<Block> = Vec::new();
    let mut unscheduled: Vec<Unscheduled> = Vec::new();

    // 1) Pinned tasks claim their fixed slots first.
    let mut occupied: Vec<(u32, u32)> =
        req.busy.iter().map(|b| (b.start_min, b.end_min)).collect();

    for t in &req.tasks {
        if t.pinned {
            if let Some(s) = t.pinned_start_min {
                let e = s + dur_of(t);
                occupied.push((s, e));
                blocks.push(Block {
                    task_id: t.id.clone(),
                    start_min: s,
                    end_min: e,
                    reason: "Pinned to this time".into(),
                });
            }
        }
    }

    // 2) Order the remaining tasks: deadline ↑, then priority/importance/energy ↓,
    //    then longer-first (pack big rocks), then id for a stable total order.
    let mut pending: Vec<&PlanTask> = req
        .tasks
        .iter()
        .filter(|t| !(t.pinned && t.pinned_start_min.is_some()))
        .collect();
    pending.sort_by(|a, b| {
        deadline_key(&a.deadline)
            .cmp(&deadline_key(&b.deadline))
            .then(priority_rank(&b.priority).cmp(&priority_rank(&a.priority)))
            .then(b.importance.cmp(&a.importance))
            .then(energy_rank(&b.energy).cmp(&energy_rank(&a.energy)))
            .then(dur_of(b).cmp(&dur_of(a)))
            .then(a.id.cmp(&b.id))
    });

    // 3) Greedily place each into the earliest fitting free window, preferring a
    //    window whose energy matches the task's.
    let mut free = free_windows(ws, we, &occupied);
    for t in pending {
        let dur = dur_of(t);
        let rank = energy_rank(&t.energy);

        // Energy-matching pass, then any-fit fallback.
        let mut chosen: Option<usize> = None;
        for (i, &(s, e)) in free.iter().enumerate() {
            if e - s >= dur && energy_at_curve(s, &req.energy_curve) >= rank {
                chosen = Some(i);
                break;
            }
        }
        if chosen.is_none() {
            for (i, &(s, e)) in free.iter().enumerate() {
                if e - s >= dur {
                    chosen = Some(i);
                    break;
                }
            }
        }

        match chosen {
            Some(i) => {
                let (s, e) = free[i];
                let start = s;
                let end = s + dur;
                if end >= e {
                    free.remove(i);
                } else {
                    free[i] = (end, e);
                }
                let reason = reason_for(t, start, &req.date, &req.busy, &req.energy_curve);
                blocks.push(Block {
                    task_id: t.id.clone(),
                    start_min: start,
                    end_min: end,
                    reason,
                });
            }
            None => unscheduled.push(Unscheduled {
                task_id: t.id.clone(),
                reason: "No free time left in your working hours".into(),
            }),
        }
    }

    blocks.sort_by_key(|b| (b.start_min, b.task_id.clone()));
    PlanResult { blocks, unscheduled }
}

// ── Team auto-planning (Act 3): balance, then schedule each member ──
//
// Mirrors src/services/teamPlanService.ts exactly so desktop (Rust) and
// web/test (TS) produce identical plans. Two deterministic phases: distribute
// unassigned work to the least-loaded member with capacity, then lay out each
// member's bucket with the same `plan` solver used for solo days.

#[derive(Deserialize, Clone)]
pub struct TeamMember {
    pub actor: String,
    #[serde(default)]
    pub work_start_min: Option<u32>,
    #[serde(default)]
    pub work_end_min: Option<u32>,
    #[serde(default)]
    pub busy: Vec<BusyBlock>,
    #[serde(default)]
    pub capacity_min: Option<u32>,
}

#[derive(Deserialize, Clone)]
pub struct TeamPlanTask {
    #[serde(flatten)]
    pub task: PlanTask,
    #[serde(default)]
    pub assignee: Option<String>,
}

#[derive(Deserialize)]
pub struct TeamPlanRequest {
    pub date: String,
    pub members: Vec<TeamMember>,
    pub tasks: Vec<TeamPlanTask>,
}

#[derive(Serialize)]
pub struct MemberLoad {
    pub actor: String,
    pub capacity_min: u32,
    pub assigned_min: u32,
    pub scheduled_min: u32,
    pub unscheduled: usize,
    pub overloaded: bool,
}

#[derive(Serialize)]
pub struct TeamAssignment {
    pub task_id: String,
    pub actor: String,
}

#[derive(Serialize)]
pub struct TeamPlanResult {
    #[serde(rename = "byMember")]
    pub by_member: HashMap<String, PlanResult>,
    pub loads: Vec<MemberLoad>,
    pub assignments: Vec<TeamAssignment>,
    pub unroutable: Vec<String>,
}

fn capacity_of(m: &TeamMember) -> u32 {
    m.capacity_min.unwrap_or_else(|| {
        m.work_end_min
            .unwrap_or(DEFAULT_WORK_END)
            .saturating_sub(m.work_start_min.unwrap_or(DEFAULT_WORK_START))
    })
}

/// Balancing order: deadline ↑, priority/importance ↓, longer-first, id.
fn by_priority(a: &PlanTask, b: &PlanTask) -> std::cmp::Ordering {
    deadline_key(&a.deadline)
        .cmp(&deadline_key(&b.deadline))
        .then(priority_rank(&b.priority).cmp(&priority_rank(&a.priority)))
        .then(b.importance.cmp(&a.importance))
        .then(dur_of(b).cmp(&dur_of(a)))
        .then(a.id.cmp(&b.id))
}

pub fn plan_team(req: &TeamPlanRequest) -> TeamPlanResult {
    let mut members = req.members.clone();
    members.sort_by(|a, b| a.actor.cmp(&b.actor));

    if members.is_empty() {
        return TeamPlanResult {
            by_member: HashMap::new(),
            loads: vec![],
            assignments: vec![],
            unroutable: req.tasks.iter().map(|t| t.task.id.clone()).collect(),
        };
    }

    let mut buckets: HashMap<String, Vec<TeamPlanTask>> =
        members.iter().map(|m| (m.actor.clone(), Vec::new())).collect();
    let mut load: HashMap<String, u32> = members.iter().map(|m| (m.actor.clone(), 0u32)).collect();
    let mut assignments: Vec<TeamAssignment> = Vec::new();

    // Phase 1a — honour explicit assignments.
    let mut free: Vec<TeamPlanTask> = Vec::new();
    for t in &req.tasks {
        match &t.assignee {
            Some(a) if buckets.contains_key(a) => {
                *load.get_mut(a).unwrap() += dur_of(&t.task);
                buckets.get_mut(a).unwrap().push(t.clone());
            }
            _ => free.push(t.clone()),
        }
    }

    // Phase 1b — distribute the rest to the least-loaded member with room.
    free.sort_by(|a, b| by_priority(&a.task, &b.task));
    for t in free {
        let d = dur_of(&t.task);
        let pick = members
            .iter()
            .min_by(|a, b| {
                let aa = load[&a.actor] + d;
                let ba = load[&b.actor] + d;
                let af = u8::from(aa > capacity_of(a));
                let bf = u8::from(ba > capacity_of(b));
                af.cmp(&bf).then(aa.cmp(&ba)).then(a.actor.cmp(&b.actor))
            })
            .unwrap()
            .actor
            .clone();
        *load.get_mut(&pick).unwrap() += d;
        assignments.push(TeamAssignment { task_id: t.task.id.clone(), actor: pick.clone() });
        buckets.get_mut(&pick).unwrap().push(t);
    }

    // Phase 2 — schedule each member's bucket with the solo solver.
    let mut by_member: HashMap<String, PlanResult> = HashMap::new();
    let mut loads: Vec<MemberLoad> = Vec::new();
    for m in &members {
        let tasks: Vec<PlanTask> = buckets[&m.actor].iter().map(|t| t.task.clone()).collect();
        let preq = PlanRequest {
            date: req.date.clone(),
            work_start_min: m.work_start_min.unwrap_or(DEFAULT_WORK_START),
            work_end_min: m.work_end_min.unwrap_or(DEFAULT_WORK_END),
            tasks,
            busy: m.busy.clone(),
            energy_curve: vec![],
        };
        let result = plan(&preq);
        let assigned_min = load[&m.actor];
        let scheduled_min: u32 = result.blocks.iter().map(|b| b.end_min - b.start_min).sum();
        let cap = capacity_of(m);
        loads.push(MemberLoad {
            actor: m.actor.clone(),
            capacity_min: cap,
            assigned_min,
            scheduled_min,
            unscheduled: result.unscheduled.len(),
            overloaded: assigned_min > cap || !result.unscheduled.is_empty(),
        });
        by_member.insert(m.actor.clone(), result);
    }

    TeamPlanResult { by_member, loads, assignments, unroutable: vec![] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, dur: u32, deadline: &str, prio: &str, energy: &str) -> PlanTask {
        PlanTask {
            id: id.into(),
            title: id.into(),
            duration_min: dur,
            energy: energy.into(),
            deadline: deadline.into(),
            priority: prio.into(),
            importance: 3,
            pinned: false,
            pinned_start_min: None,
        }
    }

    fn req(tasks: Vec<PlanTask>, busy: Vec<BusyBlock>) -> PlanRequest {
        PlanRequest {
            date: "2026-06-24".into(),
            work_start_min: DEFAULT_WORK_START,
            work_end_min: DEFAULT_WORK_END,
            tasks,
            busy,
            energy_curve: vec![],
        }
    }

    #[test]
    fn a_learned_curve_overrides_the_default_energy_placement() {
        // Curve: afternoon (13–16h) is the peak, mornings are low.
        let mut curve = vec![1u8; 24];
        for h in 13..=16 { curve[h] = 2; }
        for h in 9..=11 { curve[h] = 0; }
        // A midday block splits the day so the curve gets to pick a window.
        let busy = vec![BusyBlock { start_min: 660, end_min: 780, title: "Block".into() }];
        let mk = |curve: Vec<u8>| PlanRequest {
            date: "2026-06-24".into(),
            work_start_min: DEFAULT_WORK_START,
            work_end_min: DEFAULT_WORK_END,
            tasks: vec![task("hi", 60, "", "medium", "hi")],
            busy: busy.clone(),
            energy_curve: curve,
        };
        // Learned afternoon peak → afternoon window; default circadian → morning.
        assert!(plan(&mk(curve)).blocks[0].start_min >= (DEFAULT_WORK_START + 420));
        assert_eq!(plan(&mk(vec![])).blocks[0].start_min, DEFAULT_WORK_START);
    }

    fn overlaps(a: (u32, u32), b: (u32, u32)) -> bool {
        a.0 < b.1 && b.0 < a.1
    }

    #[test]
    fn stays_within_working_hours() {
        let r = req(
            vec![task("a", 60, "", "high", "med"), task("b", 120, "", "low", "med")],
            vec![],
        );
        let out = plan(&r);
        for b in &out.blocks {
            assert!(b.start_min >= DEFAULT_WORK_START && b.end_min <= DEFAULT_WORK_END, "block outside work hours: {b:?}");
        }
    }

    #[test]
    fn no_overlaps_among_blocks_or_busy() {
        let busy = vec![BusyBlock { start_min: DEFAULT_WORK_START + 240, end_min: DEFAULT_WORK_START + 300, title: "Standup".into() }];
        let r = req(
            vec![
                task("a", 90, "", "high", "med"),
                task("b", 90, "", "medium", "med"),
                task("c", 60, "", "low", "med"),
            ],
            busy.clone(),
        );
        let out = plan(&r);
        let mut intervals: Vec<(u32, u32)> = out.blocks.iter().map(|b| (b.start_min, b.end_min)).collect();
        for b in &busy {
            intervals.push((b.start_min, b.end_min));
        }
        for i in 0..intervals.len() {
            for j in (i + 1)..intervals.len() {
                assert!(!overlaps(intervals[i], intervals[j]), "overlap {:?} vs {:?}", intervals[i], intervals[j]);
            }
        }
    }

    #[test]
    fn earlier_deadline_is_scheduled_earlier() {
        let r = req(
            vec![
                task("later", 60, "2026-06-30", "high", "med"),
                task("sooner", 60, "2026-06-25", "low", "med"),
            ],
            vec![],
        );
        let out = plan(&r);
        let sooner = out.blocks.iter().find(|b| b.task_id == "sooner").unwrap();
        let later = out.blocks.iter().find(|b| b.task_id == "later").unwrap();
        assert!(sooner.start_min < later.start_min, "earlier deadline must come first");
    }

    #[test]
    fn busy_blocks_are_avoided() {
        let busy = vec![BusyBlock { start_min: DEFAULT_WORK_START, end_min: DEFAULT_WORK_START + 60, title: "Call".into() }];
        let r = req(vec![task("a", 60, "", "high", "med")], busy);
        let out = plan(&r);
        let a = &out.blocks.iter().find(|b| b.task_id == "a").unwrap();
        assert!(a.start_min >= DEFAULT_WORK_START + 60, "task must start after the busy block");
        assert!(a.reason.contains("right after"), "rationale should mention the meeting: {}", a.reason);
    }

    #[test]
    fn pinned_tasks_keep_their_slot() {
        let mut p = task("pinned", 60, "", "low", "med");
        p.pinned = true;
        p.pinned_start_min = Some(DEFAULT_WORK_START + 420); // 13:00 relative to day start
        let r = req(vec![p, task("a", 60, "", "high", "med")], vec![]);
        let out = plan(&r);
        let pinned = out.blocks.iter().find(|b| b.task_id == "pinned").unwrap();
        assert_eq!((pinned.start_min, pinned.end_min), (DEFAULT_WORK_START + 420, DEFAULT_WORK_START + 480));
        assert_eq!(pinned.reason, "Pinned to this time");
        // The other task must not collide with the pinned slot.
        let a = out.blocks.iter().find(|b| b.task_id == "a").unwrap();
        assert!(!overlaps((a.start_min, a.end_min), (780, 840)));
    }

    #[test]
    fn high_energy_tasks_prefer_the_morning_peak() {
        // A low task and a high task; the high one should land in the AM peak.
        let r = req(
            vec![task("deep", 60, "", "medium", "hi"), task("admin", 60, "", "medium", "lo")],
            vec![],
        );
        let out = plan(&r);
        let deep = out.blocks.iter().find(|b| b.task_id == "deep").unwrap();
        assert!(energy_at(deep.start_min) == 2, "high-energy task should be in a peak window");
    }

    #[test]
    fn overflow_is_reported_unscheduled() {
        // 17h of capacity (06–23) but 20h of work.
        let total = 20usize;
        let tasks: Vec<PlanTask> = (0..total)
            .map(|i| task(&format!("t{i}"), 60, "", "medium", "med"))
            .collect();
        let out = plan(&req(tasks, vec![]));
        let capacity = ((DEFAULT_WORK_END - DEFAULT_WORK_START) / 60) as usize;
        assert_eq!(out.blocks.len(), std::cmp::min(total, capacity));
        assert_eq!(out.unscheduled.len(), total.saturating_sub(capacity));
    }

    #[test]
    fn deterministic_same_input_same_output() {
        let make = || {
            req(
                vec![
                    task("a", 60, "2026-06-25", "high", "hi"),
                    task("b", 45, "", "low", "lo"),
                    task("c", 30, "2026-06-25", "medium", "med"),
                ],
                vec![BusyBlock { start_min: 660, end_min: 720, title: "Sync".into() }],
            )
        };
        let one = plan(&make());
        let two = plan(&make());
        let ids1: Vec<_> = one.blocks.iter().map(|b| (b.task_id.clone(), b.start_min)).collect();
        let ids2: Vec<_> = two.blocks.iter().map(|b| (b.task_id.clone(), b.start_min)).collect();
        assert_eq!(ids1, ids2);
    }

    fn tmember(actor: &str) -> TeamMember {
        TeamMember { actor: actor.into(), work_start_min: Some(DEFAULT_WORK_START), work_end_min: Some(DEFAULT_WORK_END), busy: vec![], capacity_min: None }
    }
    fn ttask(id: &str, dur: u32, assignee: Option<&str>) -> TeamPlanTask {
        TeamPlanTask { task: task(id, dur, "", "medium", "med"), assignee: assignee.map(|s| s.into()) }
    }

    #[test]
    fn team_balances_unassigned_work_evenly() {
        let req = TeamPlanRequest {
            date: "2026-06-25".into(),
            members: vec![tmember("A"), tmember("B")],
            tasks: vec![ttask("t1", 120, None), ttask("t2", 120, None), ttask("t3", 120, None), ttask("t4", 120, None)],
        };
        let out = plan_team(&req);
        let a = out.loads.iter().find(|l| l.actor == "A").unwrap();
        let b = out.loads.iter().find(|l| l.actor == "B").unwrap();
        assert_eq!(a.assigned_min, 240);
        assert_eq!(b.assigned_min, 240);
        assert_eq!(out.assignments.len(), 4);
    }

    #[test]
    fn team_honours_explicit_assignment_and_flags_overload() {
        let req = TeamPlanRequest {
            date: "2026-06-25".into(),
            members: vec![TeamMember { actor: "A".into(), work_start_min: Some(DEFAULT_WORK_START), work_end_min: Some(DEFAULT_WORK_END), busy: vec![], capacity_min: Some(120) }],
            tasks: vec![ttask("t1", 90, Some("A")), ttask("t2", 90, Some("A"))],
        };
        let out = plan_team(&req);
        assert_eq!(out.loads[0].assigned_min, 180);
        assert!(out.loads[0].overloaded);
        assert!(out.by_member.contains_key("A"));
    }

    #[test]
    fn team_marks_unroutable_without_members() {
        let req = TeamPlanRequest { date: "2026-06-25".into(), members: vec![], tasks: vec![ttask("t1", 60, None)] };
        let out = plan_team(&req);
        assert_eq!(out.unroutable, vec!["t1".to_string()]);
    }
}
