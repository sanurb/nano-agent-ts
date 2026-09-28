# /// script
# requires-python = ">=3.11"
# dependencies = ["ipython==9.17.1"]
# ///
# How to run: uv run --with-requirements ipython-requirements.txt python-cell-runner.py

from __future__ import annotations

import contextlib
import sys
from pathlib import Path
from typing import assert_never

tool_directory = str(Path(__file__).resolve().parent)
sys.path.insert(0, tool_directory)
from ipython_cell_engine import (  # noqa: E402
    IpythonCellEngine,
    IpythonCellFailure,
    IpythonCellSuccess,
)
from python_cell_protocol_runtime import (  # noqa: E402
    CellProtocolError,
    ClosedCellStdin,
    PythonCellProtocolRuntime,
)
sys.path.remove(tool_directory)


def execute_cell(
    engine: IpythonCellEngine,
    protocol: PythonCellProtocolRuntime,
    code: str,
) -> bool:
    with contextlib.redirect_stdout(
        protocol.text_stream("stdout")
    ), contextlib.redirect_stderr(protocol.text_stream("stderr")):
        result = engine.execute(code, protocol.capability_proxy())
    if protocol.protocol_broken:
        protocol.emit_result({
            "status": "protocol_error",
            "error": {
                "code": "protocol_error",
                "message": "Capability protocol synchronization was lost",
            },
        })
        return False
    match result:
        case IpythonCellSuccess(execution_count=execution_count):
            protocol.emit_result({
                "status": "ok",
                "execution_count": execution_count,
            })
        case IpythonCellFailure(
            execution_count=execution_count,
            error_name=error_name,
            error_value=error_value,
            traceback=traceback,
        ):
            protocol.emit_result({
                "status": "error",
                "execution_count": execution_count,
                "error": {
                    "code": "python_exception",
                    "message": f"{error_name}: {error_value}",
                },
                "traceback": list(traceback),
            })
        case unreachable:
            assert_never(unreachable)
    return True


def emit_runner_failure(
    protocol: PythonCellProtocolRuntime,
    error: BaseException,
) -> None:
    if not protocol.run_id:
        return
    protocol.emit_result({
        "status": "protocol_error",
        "error": {
            "code": "runner_failure",
            "message": f"{type(error).__name__}: {error}",
        },
    })


def main() -> int:  # noqa: BROAD_EXCEPT_OK
    sys.stdin = ClosedCellStdin()
    protocol = PythonCellProtocolRuntime()
    engine = IpythonCellEngine(
        protocol.emit_display,
        protocol.emit_clear_output,
    )
    protocol.emit_ready()
    while True:
        try:
            frame = protocol.read_frame(allow_eof=True)
            if frame is None:
                return 0
            code = protocol.parse_run(frame)
            if not execute_cell(engine, protocol, code):
                return 2
        except CellProtocolError as error:
            if protocol.run_id:
                protocol.emit_result({
                    "status": "protocol_error",
                    "error": {
                        "code": "protocol_error",
                        "message": str(error),
                    },
                })
            return 2
        except BaseException as error:  # noqa: BROAD_EXCEPT_OK
            emit_runner_failure(protocol, error)
            return 3


raise SystemExit(main())
