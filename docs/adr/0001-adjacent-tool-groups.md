---
status: accepted
---

# Schedule adjacent parallel tools around sequential barriers

The revised requirements chose adjacent parallel groups separated by sequential calls. This retains read/search concurrency around mutations without introducing a general dependency scheduler.

## Alternatives and trade-offs

- **Whole-batch sequential override:** simpler batch-wide ordering, but one mutation also serializes independent reads elsewhere in the batch. The revised requirements rejected that loss of concurrency.
- **General dependency scheduler:** could run independent calls across a sequential call, but would require dependency information beyond each tool's execution mode. The chosen design does not add that model.
- **Adjacent parallel groups:** use call order and declared execution modes to define boundaries. Calls in separate groups cannot overlap, even when they might be independent.

Batch scheduling does not replace cross-lane file coordination. The decision retains shared queues for cooperating file mutations and source-order tool results, but does not promise ordering for arbitrary shell effects across lanes.

Implementation and checks: [agent-lane.ts](../../app/agent/agent-lane.ts) and [tool-batch.test.ts](../../app/agent/tool-batch.test.ts).
