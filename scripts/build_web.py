"""Build only FeelyReader's public browser assets, without publishing anything.

Run ``python -m scripts.build_web`` for ``dist/web`` or pass ``--output
dist/another-site``. Every input is checked before an existing output is touched.
The manifest hashes copied assets; it deliberately excludes its own JSON file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


APP_VERSION = "0.3.0"
MAX_FILE_BYTES = 100 * 1024 * 1024
WORKSPACE = Path(__file__).resolve().parents[1]
RUNTIME_ASSETS = (
    "index.html", "styles.css", "camera.js", "opencv-loader.js", "page-detector.js",
    "page-output.js", "page-content.js", "stability.js", "live-bridge.js", "app.js",
    "reading_manager.js", "gesture-engine.js", "browser-ocr.js", "reader-controller.js",
    "e-app.js", "THIRD_PARTY.md", ".nojekyll",
    "blind-book-ocr-json-test.html", "gesture-test.js",
)
REQUIRED_VENDOR_ASSETS = (
    "vendor/opencv/opencv.js",
    "vendor/tesseract/tesseract.min.js",
    "vendor/tesseract/worker.min.js",
    "vendor/tesseract/core/tesseract-core-lstm.wasm.js",
    "vendor/tesseract/core/tesseract-core-lstm.wasm",
    "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
    "vendor/tesseract/core/tesseract-core-simd-lstm.wasm",
    "vendor/tesseract/lang/chi_sim.traineddata",
    "vendor/tesseract/lang/eng.traineddata",
    "vendor/mediapipe/hands.js",
)


class BuildError(RuntimeError):
    """An unsafe path, incomplete source, or failed build leaves no valid output."""


def _is_link(info: os.stat_result) -> bool:
    # On Windows this also rejects junctions, not just Python-visible symlinks.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _reject_link_chain(path: Path) -> None:
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise BuildError(f"Cannot inspect path {part}: {error}") from error
        if _is_link(info):
            raise BuildError(f"Symbolic links and junctions are not allowed: {part}")


def _workspace(path: Path) -> Path:
    candidate = Path(os.path.abspath(path))
    _reject_link_chain(candidate)
    if not candidate.is_dir():
        raise BuildError(f"Workspace does not exist: {candidate}")
    return candidate.resolve(strict=True)


def _output_path(workspace: Path, value: str | Path | None) -> tuple[Path, Path]:
    requested = Path(value) if value is not None else Path("dist/web")
    if ".." in requested.parts:
        raise BuildError("Output cannot contain parent-directory traversal (..).")
    candidate = requested if requested.is_absolute() else workspace / requested
    dist = workspace / "dist"
    _reject_link_chain(dist)
    _reject_link_chain(candidate)
    dist = dist.resolve(strict=False)
    output = candidate.resolve(strict=False)
    if output == dist or not output.is_relative_to(dist):
        raise BuildError("Output must be a child directory inside workspace/dist, not dist itself.")
    if output.exists() and not output.is_dir():
        raise BuildError(f"Output is not a directory: {output}")
    return output, dist


def _digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _file_record(workspace: Path, path: Path) -> dict:
    _reject_link_chain(path)
    try:
        info = path.lstat()
    except OSError as error:
        raise BuildError(f"Required asset is missing or unreadable: {path.relative_to(workspace)}") from error
    if not stat.S_ISREG(info.st_mode) or _is_link(info):
        raise BuildError(f"Asset must be a regular file: {path.relative_to(workspace)}")
    if info.st_size >= MAX_FILE_BYTES:
        raise BuildError(f"Asset must be smaller than 100 MiB: {path.relative_to(workspace)}")
    # Upstream MediaPipe includes this empty loader placeholder intentionally.
    if info.st_size == 0 and path.relative_to(workspace).as_posix() not in {
        ".nojekyll", "vendor/mediapipe/hands_solution_simd_wasm_bin.data"
    }:
        raise BuildError(f"Asset is empty: {path.relative_to(workspace)}")
    try:
        digest = _digest(path)
    except OSError as error:
        raise BuildError(f"Cannot read asset: {path.relative_to(workspace)}") from error
    return {"path": path.relative_to(workspace).as_posix(), "bytes": info.st_size, "sha256": digest}


def _vendor_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise BuildError("Required asset directory is missing: vendor")
    _reject_link_chain(directory)
    result = []
    try:
        entries = sorted(directory.iterdir(), key=lambda item: item.name)
    except OSError as error:
        raise BuildError(f"Cannot inspect vendor directory: {directory}") from error
    for path in entries:
        if path.name.startswith("."):
            raise BuildError(f"Hidden vendor paths are not allowed: {path.name}")
        try:
            info = path.lstat()
        except OSError as error:
            raise BuildError(f"Cannot inspect vendor asset: {path}") from error
        if _is_link(info):
            raise BuildError(f"Symbolic links and junctions are not allowed in vendor: {path}")
        if stat.S_ISDIR(info.st_mode):
            result.extend(_vendor_files(path))
        elif stat.S_ISREG(info.st_mode):
            result.append(path)
        else:
            raise BuildError(f"Unsupported vendor file type: {path}")
    return result


def _plan(workspace: Path) -> list[dict]:
    files = [workspace / name for name in RUNTIME_ASSETS]
    license_path = workspace / "LICENSE"
    if license_path.exists() or license_path.is_symlink():
        files.append(license_path)
    vendor = _vendor_files(workspace / "vendor")
    vendor_names = {path.relative_to(workspace).as_posix() for path in vendor}
    missing = sorted(set(REQUIRED_VENDOR_ASSETS) - vendor_names)
    if missing:
        raise BuildError("Missing required vendor assets: " + ", ".join(missing))
    files.extend(vendor)
    return sorted((_file_record(workspace, path) for path in files), key=lambda record: record["path"])


def _reject_output_links(directory: Path) -> None:
    if not directory.exists():
        return
    _reject_link_chain(directory)
    for path in directory.iterdir():
        info = path.lstat()
        if _is_link(info):
            raise BuildError(f"Output contains a symbolic link or junction: {path}")
        if stat.S_ISDIR(info.st_mode):
            _reject_output_links(path)


def _remove_build_directory(directory: Path, dist: Path) -> None:
    # This guard is used for every recursive deletion, including temporary files.
    _reject_link_chain(dist)
    _reject_link_chain(directory)
    resolved = directory.resolve(strict=False)
    resolved_dist = dist.resolve(strict=False)
    if resolved == resolved_dist or not resolved.is_relative_to(resolved_dist):
        raise BuildError("Refusing to remove a directory outside workspace/dist.")
    _reject_output_links(resolved)
    if resolved.exists():
        shutil.rmtree(resolved)


def build_web(output: str | Path | None = None, *, workspace: Path | None = None) -> Path:
    """Validate sources, assemble in dist, and replace only the requested output.

    ``workspace`` is explicit for isolated tests; CLI builds use this repository.
    A source/validation/copy failure leaves an existing build unchanged.
    """
    root = _workspace(Path(workspace) if workspace is not None else WORKSPACE)
    target, dist = _output_path(root, output)
    records = _plan(root)
    _reject_output_links(target)
    # No writes or removals have occurred before all required input is validated.
    dist.mkdir(parents=True, exist_ok=True)
    _reject_link_chain(dist)
    staging = Path(tempfile.mkdtemp(prefix=".feelyreader-build-", dir=dist))
    try:
        for record in records:
            relative = Path(record["path"])
            source = root / relative
            _reject_link_chain(source)
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            if destination.stat().st_size != record["bytes"] or _digest(destination) != record["sha256"]:
                raise BuildError(f"Source changed during build: {record['path']}")
        manifest = {"app_version": APP_VERSION, "files": records}
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        checked_target, checked_dist = _output_path(root, output)
        if checked_target != target or checked_dist != dist:
            raise BuildError("Output location changed during build.")
        target.parent.mkdir(parents=True, exist_ok=True)
        _reject_link_chain(target.parent)
        _remove_build_directory(target, dist)
        staging.rename(target)
    except OSError as error:
        raise BuildError(f"Cannot build public browser assets: {error}") from error
    finally:
        if staging.exists():
            _remove_build_directory(staging, dist)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build FeelyReader's public assets inside workspace/dist.")
    parser.add_argument("--output", help="Child directory of workspace/dist (default: dist/web).")
    args = parser.parse_args(argv)
    try:
        target = build_web(args.output)
    except (BuildError, OSError) as error:
        print(f"Web build failed: {error}", file=sys.stderr)
        return 1
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    print(f"Built FeelyReader {APP_VERSION}: {len(manifest['files'])} assets -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
