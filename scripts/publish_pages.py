"""Publish verified static artifacts to gh-pages without checking out a branch.

The current branch, working tree, and real Git index are never replaced. Git's
existing remote and credential helper configuration handles authentication.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile

from . import build_web


WORKSPACE = Path(__file__).resolve().parents[1]
TARGET_BRANCH = "gh-pages"
OBJECT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
PRIVATE_NAMES = {"cname", "mobile_ocr", "tests", "outputs", "certs", "__pycache__", "id_rsa", "id_ed25519"}
PRIVATE_SUFFIXES = {".py", ".pyc", ".pyo", ".pem", ".key", ".p12", ".pfx", ".ppk", ".env", ".exe", ".dll", ".so", ".dylib", ".ps1", ".bat", ".cmd"}


class PublishError(RuntimeError):
    """Validation, Git, or a non-fast-forward publication failed."""


@dataclass(frozen=True)
class Asset:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Build:
    root: Path
    directory: Path
    version: str
    assets: tuple[Asset, ...]
    manifest_sha256: str


def _public_path(value: object) -> str:
    if not isinstance(value, str) or not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise PublishError("Manifest contains an invalid path.")
    if any(char in value for char in ('\\', ':', '"')):
        raise PublishError("Manifest paths must be ordinary relative POSIX paths.")
    relative = PurePosixPath(value)
    if relative.is_absolute() or relative.as_posix() != value or any(part in {".", ".."} for part in relative.parts):
        raise PublishError("Manifest contains an unsafe relative path.")
    for part in relative.parts:
        name = part.casefold()
        if (part.startswith(".") and value != ".nojekyll") or part.endswith((".", " ")):
            raise PublishError(f"Hidden or ambiguous publication path: {value}")
        if name in PRIVATE_NAMES or "secret" in name or name.startswith("credential") or name in {"token", "token.txt", "token.json"}:
            raise PublishError(f"Private/backend paths cannot be published: {value}")
    if relative.suffix.casefold() in PRIVATE_SUFFIXES:
        raise PublishError(f"Private/backend file type cannot be published: {value}")
    allowed_root = set(build_web.RUNTIME_ASSETS) | {"LICENSE", "manifest.json"}
    if value not in allowed_root and (len(relative.parts) < 2 or relative.parts[0] != "vendor"):
        raise PublishError(f"File is outside the public runtime allowlist: {value}")
    return value


def _inventory(directory: Path) -> dict[str, Path]:
    files = {}

    def visit(folder: Path) -> None:
        build_web._reject_link_chain(folder)
        for path in sorted(folder.iterdir(), key=lambda item: item.name):
            info = path.lstat()
            if build_web._is_link(info):
                raise PublishError("Publication cannot contain symlinks or junctions.")
            relative = path.relative_to(directory).as_posix()
            if stat.S_ISDIR(info.st_mode):
                # Validate directories even if they contain no files.
                if any(part.startswith(".") or part.casefold() in PRIVATE_NAMES or "secret" in part.casefold()
                       or part.casefold().startswith("credential") for part in Path(relative).parts):
                    raise PublishError(f"Private directory cannot be published: {relative}")
                if Path(relative).parts[0] != "vendor":
                    raise PublishError(f"Unexpected directory in public build: {relative}")
                visit(path)
            elif stat.S_ISREG(info.st_mode):
                files[_public_path(relative)] = path
            else:
                raise PublishError(f"Unsupported publication file type: {relative}")

    visit(directory)
    return files


def validate_build(output: str | Path | None = None, *, workspace: Path | None = None) -> Build:
    root = build_web._workspace(Path(workspace) if workspace is not None else WORKSPACE)
    directory, _ = build_web._output_path(root, output)
    if not directory.is_dir():
        raise PublishError("Build is missing; run python -m scripts.build_web first.")
    inventory = _inventory(directory)
    if "manifest.json" not in inventory:
        raise PublishError("Build manifest.json is missing.")
    manifest_path = inventory["manifest.json"]
    if not 0 < manifest_path.stat().st_size < build_web.MAX_FILE_BYTES:
        raise PublishError("Build manifest has an invalid size.")
    raw_manifest = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw_manifest.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublishError("Build manifest is not valid UTF-8 JSON.") from error
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list):
        raise PublishError("Build manifest must contain a files array.")
    version = manifest.get("app_version")
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", version):
        raise PublishError("Build manifest has an invalid app_version.")
    assets, seen = [], set()
    for record in manifest["files"]:
        if not isinstance(record, dict) or set(record) != {"path", "bytes", "sha256"}:
            raise PublishError("Manifest asset record must contain path, bytes and sha256.")
        relative = _public_path(record["path"])
        if relative == "manifest.json" or relative.casefold() in seen:
            raise PublishError("Manifest contains a duplicate or self-referencing path.")
        seen.add(relative.casefold())
        size, digest = record["bytes"], record["sha256"]
        if type(size) is not int or size < 0 or size >= build_web.MAX_FILE_BYTES or (size == 0 and relative not in {
            ".nojekyll", "vendor/mediapipe/hands_solution_simd_wasm_bin.data"
        }):
            raise PublishError(f"Manifest size is invalid: {relative}")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise PublishError(f"Manifest hash is invalid: {relative}")
        path = inventory.get(relative)
        if path is None or path.stat().st_size != size or build_web._digest(path) != digest:
            raise PublishError(f"Build asset does not match its manifest: {relative}")
        assets.append(Asset(relative, size, digest))
    expected = {asset.path for asset in assets}
    if set(inventory) != expected | {"manifest.json"}:
        raise PublishError("Public build contains files absent from its manifest.")
    required = set(build_web.RUNTIME_ASSETS) | set(build_web.REQUIRED_VENDOR_ASSETS)
    if not required.issubset(expected):
        raise PublishError("Public build is missing required runtime/model assets.")
    manifest_digest = hashlib.sha256(raw_manifest).hexdigest()
    assets.append(Asset("manifest.json", len(raw_manifest), manifest_digest))
    return Build(root, directory, version, tuple(sorted(assets, key=lambda asset: asset.path)), manifest_digest)


class Git:
    def __init__(self, root: Path):
        self.root = root

    def run(self, arguments: list[str], *, stdin: bytes | None = None,
            index: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"):
            environment.pop(key, None)
        if index is not None:
            environment["GIT_INDEX_FILE"] = str(index)
        result = subprocess.run(
            ["git", "-c", f"safe.directory={self.root}", "-C", str(self.root), *arguments],
            input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
        )
        if check and result.returncode:
            # Do not echo remote URLs or credential-helper output into logs.
            raise PublishError(f"Git {arguments[0]} failed (exit {result.returncode}); inspect the remote, permissions or concurrent updates. No force push was used.")
        return result


def _oid(result: subprocess.CompletedProcess) -> str:
    value = result.stdout.decode("ascii").strip()
    if not OBJECT_ID.fullmatch(value):
        raise PublishError("Git returned an invalid object ID.")
    return value


def _verified_bytes(build: Build, asset: Asset) -> bytes:
    path = build.directory / asset.path
    build_web._reject_link_chain(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise PublishError(f"Asset changed file type before publishing: {asset.path}")
    content = path.read_bytes()
    if len(content) != asset.size or hashlib.sha256(content).hexdigest() != asset.sha256:
        raise PublishError(f"Asset changed after validation: {asset.path}")
    return content


def publish_pages(output: str | Path | None = None, remote: str = "origin", *,
                  workspace: Path | None = None, git: Git | None = None, check_only: bool = False) -> str:
    build = validate_build(output, workspace=workspace)
    command = git if git is not None else Git(build.root)
    actual_root = Path(command.run(["rev-parse", "--show-toplevel"]).stdout.decode("utf-8").strip()).resolve()
    if actual_root != build.root:
        raise PublishError("Publication workspace must be the Git repository root.")
    source_head = _oid(command.run(["rev-parse", "--verify", "HEAD^{commit}"]))
    branch = command.run(["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
    if branch.returncode == 0 and branch.stdout.decode("utf-8").strip() == TARGET_BRANCH:
        raise PublishError("Run publication from the integrated source checkout, not gh-pages.")
    if command.run(["status", "--porcelain", "--untracked-files=normal"]).stdout.strip():
        raise PublishError("Commit source changes before publishing so Source-Commit identifies the actual build.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", remote):
        raise PublishError("Remote must be a configured Git remote name.")
    configured = command.run(["remote"]).stdout.decode("utf-8").splitlines()
    if remote not in configured:
        raise PublishError("Requested Git remote is not configured.")
    ignored = command.run(["check-ignore", "--quiet", "--no-index", "outputs/.pages-publish-probe"], check=False)
    if ignored.returncode != 0:
        raise PublishError("workspace/outputs must be ignored before creating an isolated Git index.")
    if check_only:
        return source_head

    target_ref = f"refs/heads/{TARGET_BRANCH}"
    advertised = command.run(["ls-remote", "--exit-code", "--heads", remote, target_ref], check=False)
    if advertised.returncode not in {0, 2}:
        raise PublishError("Cannot query the remote gh-pages branch; check authentication or networking.")
    previous = None
    if advertised.returncode == 0:
        entries = advertised.stdout.decode("ascii").splitlines()
        if not any(line.split()[-1:] == [target_ref] for line in entries):
            raise PublishError("Remote branch query returned an unexpected reference.")
        tracking_ref = f"refs/remotes/{remote}/{TARGET_BRANCH}"
        command.run(["fetch", "--no-tags", "--no-prune", remote, f"{target_ref}:{tracking_ref}"])
        previous = _oid(command.run(["rev-parse", "--verify", f"{tracking_ref}^{{commit}}"]))

    outputs = build.root / "outputs"
    build_web._reject_link_chain(outputs)
    outputs.mkdir(exist_ok=True)
    build_web._reject_link_chain(outputs)
    temporary = Path(tempfile.mkdtemp(prefix=".pages-publish-", dir=outputs))
    try:
        index = temporary / "index"
        command.run(["read-tree", "--empty"], index=index)
        entries = []
        for asset in build.assets:
            content = _verified_bytes(build, asset)
            blob = _oid(command.run(["hash-object", "-w", "--stdin", "--no-filters"], stdin=content))
            entries.append(f"100644 {blob}\t{asset.path}\n")
        command.run(["update-index", "--index-info"], stdin="".join(entries).encode("utf-8"), index=index)
        tree = _oid(command.run(["write-tree"], index=index))
        message = f"Publish FeelyReader {build.version}\n\nSource-Commit: {source_head}\nBuild-Manifest-SHA256: {build.manifest_sha256}\n".encode("utf-8")
        arguments = ["commit-tree", tree] + (["-p", previous] if previous else [])
        commit = _oid(command.run(arguments, stdin=message))
        if _oid(command.run(["rev-parse", "--verify", "HEAD^{commit}"])) != source_head:
            raise PublishError("Source HEAD changed during publication; retry from the intended source commit.")
        command.run(["push", "--no-follow-tags", remote, f"{commit}:{target_ref}"])
        return commit
    finally:
        # Verify the exact recursive-cleanup target before deleting our own
        # temporary index directory; never remove outputs or any build folder.
        build_web._reject_link_chain(outputs)
        build_web._reject_link_chain(temporary)
        target = temporary.resolve(strict=False)
        parent = outputs.resolve(strict=True)
        if target == parent or not target.is_relative_to(parent):
            raise PublishError("Refusing to remove a temporary directory outside workspace/outputs.")
        build_web._reject_output_links(target)
        if target.exists():
            shutil.rmtree(target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish a verified FeelyReader static build to gh-pages without changing the source checkout.")
    parser.add_argument("--output", default="dist/web", help="Build directory inside workspace/dist (default: dist/web).")
    parser.add_argument("--remote", default="origin", help="Configured Git remote name (default: origin).")
    parser.add_argument("--check", action="store_true", help="Validate the build and local source checkout only; no network or Git object writes.")
    args = parser.parse_args(argv)
    try:
        commit = publish_pages(args.output, args.remote, check_only=args.check)
    except (PublishError, build_web.BuildError, OSError, ValueError) as error:
        print(f"Pages publication failed: {error}", file=sys.stderr)
        return 1
    print(f"{'Validated source' if args.check else 'Published gh-pages commit'}: {commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
