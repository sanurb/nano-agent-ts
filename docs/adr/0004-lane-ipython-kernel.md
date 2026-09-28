---
status: accepted
---

# Embed one IPython kernel behind each agent lane

`Eval` uses a real `InteractiveShell` in one long-lived subprocess per agent lane. The model owns Python composition; the host retains capability admission, effect journaling, resource budgets, process ownership, credentials, and sandbox policy.

## Why `InteractiveShell`

The previous AST evaluator provided persistent variables but not IPython input transforms, magics, `In`/`Out` history, top-level `await`, rich MIME formatting, or IPython tracebacks. Reimplementing those behaviors would create a second, incomplete Python frontend.

`ipykernel`, Jupyter messaging, ZeroMQ, and heartbeat processes were rejected. They add another transport and more process lifecycle without improving this application's host-owned newline protocol. `InteractiveShell` supplies the execution semantics directly.

## Runtime contract

- One serialized shell and namespace belong to one lane and generation.
- A branch lane receives a separate kernel; heaps are never cloned.
- The runner emits a versioned ready frame before accepting source.
- Standard streams, MIME displays, execution counts, and tracebacks use bounded strict frames.
- `sys.__stdin__` belongs only to the protocol; user-facing stdin raises `EOFError`.
- `cap.read`, `cap.glob`, and `cap.grep` cross back through the journaled capability runtime.
- Normal Python exceptions preserve the generation.
- Reset, cancellation, timeout, output or call limits, protocol loss, process exit, and the Docker lease retire it.
- Completed cells and external effects are never replayed to reconstruct a lost heap.

The local adapter uses uv with the same hash-pinned requirements file installed into the Docker virtual environment. The sandbox remains non-root, read-only, networkless, credential-free, and without a workspace mount.

## Evidence boundary

The executable tests prove IPython persistence, lane isolation, reset, top-level async, magics, rich displays and updates, history, formatted exceptions, closed stdin, nested capability lineage, protocol-loss retirement, queued cancellation, and descendant cleanup. Docker-specific execution still requires the separately configured digest-pinned sandbox image.
