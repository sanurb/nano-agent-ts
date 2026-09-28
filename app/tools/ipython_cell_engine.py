"""Persistent IPython execution and rich display projection."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Dict, List, Literal, Optional, Protocol, Tuple, TypeVar, Union

from IPython.core.displayhook import DisplayHook
from IPython.core.displaypub import DisplayPublisher
from IPython.core.interactiveshell import InteractiveShell
from traitlets.config import Config

MAX_TRACEBACK_CHARACTERS = 65_536
MAX_TRACEBACK_LINES = 256

JsonScalar = Union[str, int, float, bool, None]
JsonValue = Union[JsonScalar, List["JsonValue"], Dict[str, "JsonValue"]]
MimeBundle = Dict[str, JsonValue]
DisplayKind = Literal["execute_result", "display_data", "update_display_data"]
CapabilityProxyType = TypeVar("CapabilityProxyType")


class DisplayEmitter(Protocol):
    """Publish one JSON-compatible IPython display through the host protocol."""

    def __call__(
        self,
        kind: DisplayKind,
        data: MimeBundle,
        metadata: MimeBundle,
        execution_count: Optional[int],
        display_id: Optional[str],
    ) -> None: ...


class ClearOutputEmitter(Protocol):
    """Publish one IPython clear-output event through the host protocol."""

    def __call__(self, wait: bool) -> None: ...


@dataclass(frozen=True, slots=True)
class IpythonCellSuccess:
    """Successful cell with the corresponding IPython history counter."""

    execution_count: int


@dataclass(frozen=True, slots=True)
class IpythonCellFailure:
    """Failed cell with a no-color structured IPython traceback."""

    execution_count: int
    error_name: str
    error_value: str
    traceback: Tuple[str, ...]


IpythonCellResult = Union[IpythonCellSuccess, IpythonCellFailure]


@dataclass(frozen=True, slots=True)
class MissingCellShellError(RuntimeError):
    """IPython constructed a display adapter without its owning shell."""

    surface: str

    def __str__(self) -> str:
        return f"IPython {self.surface} has no cell shell"


class CellDisplayPublisher(DisplayPublisher):
    """Route display() MIME bundles to the framed host protocol."""

    def publish(
        self,
        data: MimeBundle,
        metadata: Optional[MimeBundle] = None,
        source=None,
        *,
        transient: Optional[MimeBundle] = None,
        update: bool = False,
        **kwargs: JsonValue,
    ) -> None:
        del source, kwargs
        shell = self.shell
        if not isinstance(shell, CellShell):
            raise MissingCellShellError(surface="display publisher")
        raw_display_id = (transient or {}).get("display_id")
        display_id = raw_display_id if isinstance(raw_display_id, str) else None
        shell.emit_display(
            "update_display_data" if update else "display_data",
            data,
            metadata or {},
            None,
            display_id,
        )

    def clear_output(self, wait: bool = False) -> None:
        shell = self.shell
        if not isinstance(shell, CellShell):
            raise MissingCellShellError(surface="display publisher")
        shell.emit_clear_output(wait)


class CellDisplayHook(DisplayHook):
    """Capture final-expression MIME bundles without terminal prompts."""

    def write_output_prompt(self) -> None:
        return

    def write_format_data(
        self,
        format_dict: MimeBundle,
        md_dict: Optional[MimeBundle] = None,
    ) -> None:
        shell = self.shell
        if not isinstance(shell, CellShell):
            raise MissingCellShellError(surface="display hook")
        shell.emit_display(
            "execute_result",
            format_dict,
            md_dict or {},
            self.prompt_count,
            None,
        )

    def finish_displayhook(self) -> None:
        self._is_active = False


class CellShell(InteractiveShell):
    """Single process-wide IPython shell whose terminal output is protocol-owned."""

    def __init__(
        self,
        *args,
        emit_display: DisplayEmitter,
        emit_clear_output: ClearOutputEmitter,
        **kwargs,
    ) -> None:
        self._emit_display = emit_display
        self._emit_clear_output = emit_clear_output
        super().__init__(*args, **kwargs)

    def emit_display(
        self,
        kind: DisplayKind,
        data: MimeBundle,
        metadata: MimeBundle,
        execution_count: Optional[int],
        display_id: Optional[str],
    ) -> None:
        self._emit_display(kind, data, metadata, execution_count, display_id)

    def emit_clear_output(self, wait: bool) -> None:
        self._emit_clear_output(wait)

    def showtraceback(self, *args, **kwargs) -> None:
        return

    def showsyntaxerror(self, *args, **kwargs) -> None:
        return

    def ask_exit(self) -> None:
        raise SystemExit("IPython kernel exit is disabled; use Eval action='reset'")


class IpythonCellEngine:
    """Own one persistent IPython namespace and in-memory history."""

    def __init__(
        self,
        emit_display: DisplayEmitter,
        emit_clear_output: ClearOutputEmitter,
    ) -> None:
        config = Config()
        config.HistoryManager.hist_file = ":memory:"
        config.InteractiveShell.cache_size = 200
        config.InteractiveShell.colors = "NoColor"
        config.InteractiveShell.xmode = "Context"
        CellShell.clear_instance()
        self._shell = CellShell.instance(
            config=config,
            user_ns={},
            displayhook_class=CellDisplayHook,
            display_pub_class=CellDisplayPublisher,
            emit_display=emit_display,
            emit_clear_output=emit_clear_output,
        )
        self._shell.autoawait = True
        sys.displayhook = self._shell.displayhook

    def execute(
        self,
        code: str,
        capability_proxy: CapabilityProxyType,
    ) -> IpythonCellResult:
        """Run one history-bearing cell; IPython owns transformations and autoawait."""

        self._shell.user_ns["cap"] = capability_proxy
        result = self._shell.run_cell(code, store_history=True, silent=False)
        self._shell.exit_now = False
        execution_count = result.execution_count or max(1, self._shell.execution_count - 1)
        error = result.error_before_exec or result.error_in_exec
        if error is None:
            return IpythonCellSuccess(execution_count=execution_count)
        traceback = self._bounded_traceback(error)
        return IpythonCellFailure(
            execution_count=execution_count,
            error_name=type(error).__name__,
            error_value=str(error),
            traceback=traceback,
        )

    def _bounded_traceback(self, error: BaseException) -> Tuple[str, ...]:
        lines = self._shell.InteractiveTB.structured_traceback(
            type(error),
            error,
            error.__traceback__,
        )
        retained: List[str] = []
        characters = 0
        for line in lines[:MAX_TRACEBACK_LINES]:
            remaining = MAX_TRACEBACK_CHARACTERS - characters
            if remaining <= 0:
                break
            retained.append(line[:remaining])
            characters += len(retained[-1])
        return tuple(retained)
