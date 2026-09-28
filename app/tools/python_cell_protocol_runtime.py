"""Versioned framing and host capability calls for one IPython subprocess."""

from __future__ import annotations

import io
import json
import platform
import sys
import uuid
from typing import Dict, Final, List, Optional, Union

import IPython

from ipython_cell_engine import DisplayKind, MimeBundle

MAX_FRAME_BYTES: Final = 1_048_576
MAX_CODE_BYTES: Final = 262_144
MAX_DISPLAY_BYTES: Final = 65_536
PROTOCOL_VERSION: Final = 2

JsonScalar = Union[str, int, float, bool, None]
JsonValue = Union[JsonScalar, List["JsonValue"], Dict[str, "JsonValue"]]


class CellProtocolError(RuntimeError):
    """A framed host message violated the IPython cell protocol."""


class CapabilityCallError(RuntimeError):
    """A host capability returned a normal tool error."""


class ClosedCellStdin(io.TextIOBase):
    """Prevent user code and interactive debuggers from consuming protocol frames."""

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> str:
        del size
        raise EOFError("stdin is not available in an IPython cell")

    def readline(self, size: int = -1) -> str:
        del size
        raise EOFError("stdin is not available in an IPython cell")

    def readlines(self, hint: int = -1) -> List[str]:
        del hint
        raise EOFError("stdin is not available in an IPython cell")


class PythonCellProtocolRuntime:
    """Own framing identity, sequence, and capability synchronization state."""

    def __init__(self) -> None:
        self._run_id = ""
        self._sequence = 0
        self._tool_names: dict[str, str] = {}
        self._protocol_broken = False

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def protocol_broken(self) -> bool:
        return self._protocol_broken

    def emit_ready(self) -> None:
        self._sequence += 1
        self._emit({
            "v": PROTOCOL_VERSION,
            "type": "ready",
            "seq": self._sequence,
            "python_version": platform.python_version(),
            "ipython_version": IPython.__version__,
        })

    def emit_result(self, payload: dict[str, JsonValue]) -> None:
        self._emit_sequenced("result", payload)

    def emit_clear_output(self, wait: bool) -> None:
        self._emit_sequenced("clear_output", {"wait": wait})

    def emit_display(
        self,
        kind: DisplayKind,
        data: MimeBundle,
        metadata: MimeBundle,
        execution_count: Optional[int],
        display_id: Optional[str],
    ) -> None:
        payload: dict[str, JsonValue] = {
            "kind": kind,
            "data": _bounded_mime_bundle(data),
            "metadata": _bounded_mime_bundle(metadata) if metadata else {},
        }
        if execution_count is not None:
            payload["execution_count"] = execution_count
        if display_id is not None:
            payload["display_id"] = display_id
        self._emit_sequenced("display", payload)

    def read_frame(self, *, allow_eof: bool = False) -> Optional[dict[str, JsonValue]]:
        protocol_input = sys.__stdin__
        if protocol_input is None:
            raise CellProtocolError("Host protocol input is unavailable")
        line = protocol_input.buffer.readline(MAX_FRAME_BYTES + 1)
        if not line:
            if allow_eof:
                return None
            raise CellProtocolError("Host closed the IPython cell protocol")
        if len(line) > MAX_FRAME_BYTES or not line.endswith(b"\n"):
            raise CellProtocolError("Host frame exceeded its byte limit or lacked LF")
        try:
            decoded = json.loads(line[:-1].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CellProtocolError("Host frame was not valid UTF-8 JSON") from error
        if not isinstance(decoded, dict):
            raise CellProtocolError("Host frame must be a JSON object")
        return decoded

    def parse_run(self, frame: dict[str, JsonValue]) -> str:
        if set(frame) != {"v", "type", "run_id", "code", "tools"}:
            raise CellProtocolError("Run frame fields were invalid")
        run_id, code, tools = frame["run_id"], frame["code"], frame["tools"]
        if (
            frame["v"] != PROTOCOL_VERSION
            or frame["type"] != "run"
            or not isinstance(run_id, str)
        ):
            raise CellProtocolError("Run frame identity was invalid")
        if not isinstance(code, str) or len(code.encode("utf-8")) > MAX_CODE_BYTES:
            raise CellProtocolError("IPython source exceeded its byte limit")
        if not isinstance(tools, list):
            raise CellProtocolError("Run frame tools must be a list")
        names: dict[str, str] = {}
        for item in tools:
            if not isinstance(item, dict) or set(item) != {"alias", "name"}:
                raise CellProtocolError("Capability descriptor was invalid")
            alias, name = item["alias"], item["name"]
            if not isinstance(alias, str) or not isinstance(name, str) or alias in names:
                raise CellProtocolError("Capability descriptor identity was invalid")
            names[alias] = name
        self._run_id = run_id
        self._tool_names = names
        self._protocol_broken = False
        return code

    def capability_proxy(self) -> CapabilityProxy:
        return CapabilityProxy(self)

    def text_stream(self, stream: str) -> FramedTextStream:
        return FramedTextStream(self, stream)

    def call_capability(
        self,
        alias: str,
        arguments: dict[str, JsonValue],
    ) -> JsonValue:
        name = self._tool_names.get(alias)
        if name is None:
            raise CapabilityCallError(f"Capability is not available: {alias}")
        call_id = f"py-{uuid.uuid4().hex}"
        self._emit_sequenced(
            "tool_call",
            {"call_id": call_id, "name": name, "args": arguments},
        )
        reply = self.read_frame()
        if reply is None:
            raise self._protocol_failure("Host closed during a capability call")
        expected = {"v", "type", "run_id", "call_id", "ok"}
        if set(reply) - (expected | {"value", "error"}):
            raise self._protocol_failure("Tool reply had unknown fields")
        if (
            reply.get("v") != PROTOCOL_VERSION
            or reply.get("type") != "tool_reply"
            or reply.get("run_id") != self._run_id
            or reply.get("call_id") != call_id
            or not isinstance(reply.get("ok"), bool)
        ):
            raise self._protocol_failure(
                "Tool reply did not match the outstanding capability call"
            )
        if reply["ok"] is True:
            return reply.get("value")
        error = reply.get("error")
        message = (
            error.get("message")
            if isinstance(error, dict)
            else "Capability call failed"
        )
        raise CapabilityCallError(str(message))

    def _emit(self, frame: dict[str, JsonValue]) -> None:
        encoded = json.dumps(
            frame,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise CellProtocolError("Runner frame exceeded its byte limit")
        sys.__stdout__.write(f"{encoded}\n")
        sys.__stdout__.flush()

    def _emit_sequenced(
        self,
        frame_type: str,
        payload: dict[str, JsonValue],
    ) -> None:
        self._sequence += 1
        self._emit({
            "v": PROTOCOL_VERSION,
            "type": frame_type,
            "run_id": self._run_id,
            "seq": self._sequence,
            **payload,
        })

    def _protocol_failure(self, message: str) -> CellProtocolError:
        self._protocol_broken = True
        return CellProtocolError(message)


class FramedTextStream(io.TextIOBase):
    """Redirect user output into framed protocol messages."""

    def __init__(self, protocol: PythonCellProtocolRuntime, stream: str) -> None:
        self._protocol = protocol
        self._stream = stream

    def writable(self) -> bool:
        return True

    def write(self, value: str) -> int:
        if value:
            self._protocol._emit_sequenced(self._stream, {"data": value})
        return len(value)

    def flush(self) -> None:
        sys.__stdout__.flush()


class CapabilityCallable:
    """Callable proxy for one host-admitted capability."""

    def __init__(self, protocol: PythonCellProtocolRuntime, alias: str) -> None:
        self._protocol = protocol
        self._alias = alias

    def __call__(self, **arguments: JsonValue) -> JsonValue:
        return self._protocol.call_capability(self._alias, arguments)


class CapabilityProxy:
    """Attribute-based access to host-admitted capabilities."""

    def __init__(self, protocol: PythonCellProtocolRuntime) -> None:
        self._protocol = protocol

    def __getattr__(self, alias: str) -> CapabilityCallable:
        if alias.startswith("_"):
            raise AttributeError(alias)
        return CapabilityCallable(self._protocol, alias)


def _bounded_mime_bundle(bundle: MimeBundle) -> MimeBundle:
    retained: MimeBundle = {}
    remaining = MAX_DISPLAY_BYTES
    preferred = ["text/plain", "text/markdown", "text/html", "application/json"]
    ordered = [mime for mime in preferred if mime in bundle]
    ordered.extend(mime for mime in bundle if mime not in ordered)
    for mime in ordered:
        value = bundle[mime]
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        cost = len(mime.encode("utf-8")) + len(encoded.encode("utf-8"))
        if cost <= remaining:
            retained[mime] = value
            remaining -= cost
    if retained:
        return retained
    return {"text/plain": "[IPython display omitted: MIME bundle exceeded the output limit]"}
