# Isolated merge queue integration harness

Source: `82693a708c36867e3ee3d3846112889153d2bed1`. Target: `codex-mq-integration-rerun-20261113`. Controller: `codex/mq-integration-controller-rerun-20261113`.

This is disposable test tooling, not production configuration. It never enables
master/main admission, modifies their protections, changes repository auto-merge,
or deploys Tide configuration. Only the dedicated test rule and branches may be
created or removed by orchestration. Test rule must have no bypass actors.

Candidate overlay adds the test base to constrained PR triggers, and permits its
identity in the existing queue guard and image provenance validator. All 32 queue
lanes, shards, required guard jobs and image checks remain. Merge-group triggers
remain master/main to preserve existing production routing tests. The checked-in
policy remains disabled. Inventory is regenerated from actual modified headers.

Controller code is an immutable source copy with test-base allowlists and a
separate `mq-integration-passed` status context. It reads real PR workflow evidence,
runs the pinned independent checker, and uses the actual admission, dispatch and
candidate publisher implementation. It never executes candidate artifacts or
code. Its inventory adapter adds only the test branch to parsed merge-group
filters in memory. Exact upstream blobs/header hashes and full inventory still
validate. Informational status-label mutations are disabled; approval/hold labels
remain real inputs, never added by the harness.

`admit` verifies selected temporary PR CI and reconciles admission; `recover`
reconciles existing test queue entries and dispatch/results independently of event
delivery; `snapshot` only records evidence. All operations are manually dispatched
to the controller branch's existing registered `ci-scripts-tests.yml` filename.
Concurrency serializes every controller operation. Evidence artifacts contain
queue snapshots, exact-SHA runs/statuses and mutating API operation metadata; they
never contain request headers or tokens.

Limits: branch admission aliases, the isolated status context and manual controller
wakeups are harness adaptations. This validates full actual CI execution and queue
lifecycle mechanics, but cannot establish unchanged production branch event
routing, automatic default-branch workflow delivery or scheduled timing. A later
coordinated activation smoke test remains necessary. Real DCO on queue SHAs must
be observed; do not forge or waive it. Clean up all temporary branches, PRs and the
test ruleset, cancel residual test runs, and compare protected-branch/settings
snapshots after testing.
