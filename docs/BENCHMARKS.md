# Performance Validation

This checkout has no reproducible benchmark harness or retained measurement artifacts. Previously published latency, memory, relay-load, browser-compatibility, and competitor comparisons are withdrawn because they cannot be verified from this repository. Test pass counts are not performance measurements.

Before publishing a performance claim, record the commit, build mode, OS/hardware/browser versions, fixture, repetitions, warm-up, and raw results. Report distributions rather than one sample.

The production roadmap calls for measurements of:

- Planner duration and output validity at representative task/calendar sizes, on both engines.
- Cold/warm startup, responsiveness, and memory with large workspaces.
- Storage growth, quota failure, migration time, and concurrent writes.
- Whole-log encryption and sync costs as history grows.
- Relay disk persistence, oversized input, long-poll worker saturation, and restart recovery.
- Fresh-install offline PWA startup and update behavior on supported browsers.

These are future acceptance checks, not completed results. See [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md) and [TESTING.md](TESTING.md).
