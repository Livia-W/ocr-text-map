"""Public web builds cannot expose repository files or delete outside dist.

All writes/removals in these tests use a temporary fixture workspace. Real
repository output and real vendor/model files are never modified.
"""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import build_web as web


class WebBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="feelyreader-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "workspace"
        self.root.mkdir()
        for name in (*web.RUNTIME_ASSETS, *web.REQUIRED_VENDOR_ASSETS):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"" if name == ".nojekyll" else b"public fixture asset\n")

    def existing_output(self):
        output = self.root / "dist/web"
        output.mkdir(parents=True, exist_ok=True)
        (output / "keep.txt").write_text("previous valid build", encoding="utf-8")
        return output

    def assert_preserved(self, output):
        self.assertEqual((output / "keep.txt").read_text(encoding="utf-8"), "previous valid build")

    def symlink(self, target, link, directory=False):
        try:
            os.symlink(target, link, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"OS does not permit creating a test symlink: {error}")

    def test_only_public_allowlist_and_validated_vendor_are_copied(self):
        excluded = ["CNAME", ".env", "README.md", "main.cpp", "A_HANDOFF.md", "paperpal_d.html",
                    "mobile_ocr/server.py", "tests/private.json", ".tools/config.json", "outputs/result.json"]
        for name in excluded:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private fixture content", encoding="utf-8")
        (self.root / "LICENSE").write_text("public license", encoding="utf-8")
        extra_vendor = "vendor/mediapipe/models/hand_landmark.tflite"
        path = self.root / extra_vendor
        path.parent.mkdir()
        path.write_bytes(b"public model")
        output = web.build_web(workspace=self.root)
        self.assertEqual(output, self.root / "dist/web")
        actual = {path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()}
        expected = set(web.RUNTIME_ASSETS) | set(web.REQUIRED_VENDOR_ASSETS) | {"LICENSE", extra_vendor, "manifest.json"}
        self.assertEqual(actual, expected)
        self.assertFalse(any((output / name).exists() for name in excluded))
        self.assertEqual((output / ".nojekyll").read_bytes(), b"")

    def test_manifest_contains_only_relative_paths_exact_sizes_and_sha256(self):
        output = web.build_web(workspace=self.root)
        manifest_text = (output / "manifest.json").read_text(encoding="utf-8")
        manifest = json.loads(manifest_text)
        self.assertEqual(manifest["app_version"], "0.3.0")
        self.assertNotIn(str(self.root), manifest_text)
        self.assertNotIn("private", manifest_text)
        records = manifest["files"]
        self.assertEqual([item["path"] for item in records], sorted(item["path"] for item in records))
        self.assertNotIn("manifest.json", [item["path"] for item in records])
        self.assertEqual(len(records), len(web.RUNTIME_ASSETS) + len(web.REQUIRED_VENDOR_ASSETS))
        for record in records:
            with self.subTest(path=record["path"]):
                content = (output / record["path"]).read_bytes()
                self.assertEqual(set(record), {"path", "bytes", "sha256"})
                self.assertFalse(Path(record["path"]).is_absolute())
                self.assertEqual(record["bytes"], len(content))
                self.assertEqual(record["sha256"], hashlib.sha256(content).hexdigest())
        original = manifest_text
        web.build_web(workspace=self.root)
        self.assertEqual((output / "manifest.json").read_text(encoding="utf-8"), original)

    def test_missing_runtime_does_not_clear_existing_output(self):
        output = self.existing_output()
        (self.root / "e-app.js").unlink()
        with self.assertRaises(web.BuildError):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_missing_model_does_not_clear_existing_output(self):
        output = self.existing_output()
        (self.root / "vendor/tesseract/lang/chi_sim.traineddata").unlink()
        with self.assertRaisesRegex(web.BuildError, "chi_sim"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_upstream_empty_mediapipe_placeholder_is_preserved(self):
        relative = "vendor/mediapipe/hands_solution_simd_wasm_bin.data"
        path = self.root / relative
        path.write_bytes(b"")
        output = web.build_web(workspace=self.root)
        self.assertEqual((output / relative).read_bytes(), b"")
        (self.root / "vendor/mediapipe/unexpected.data").write_bytes(b"")
        with self.assertRaisesRegex(web.BuildError, "empty"):
            web.build_web(workspace=self.root)

    def test_empty_required_asset_and_100mib_asset_are_rejected_before_cleanup(self):
        output = self.existing_output()
        path = self.root / "vendor/tesseract/lang/eng.traineddata"
        path.write_bytes(b"")
        with self.assertRaisesRegex(web.BuildError, "empty"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)
        # A sparse boundary fixture avoids allocating a 100 MiB Python object.
        with path.open("wb") as stream:
            stream.truncate(100 * 1024 * 1024)
        with self.assertRaisesRegex(web.BuildError, "smaller than 100 MiB"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_hidden_vendor_files_and_directories_are_rejected(self):
        output = self.existing_output()
        for name in [".env", ".git/config", "models/.private/token"]:
            with self.subTest(path=name):
                path = self.root / "vendor" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("private", encoding="utf-8")
                with self.assertRaisesRegex(web.BuildError, "Hidden"):
                    web.build_web(workspace=self.root)
                self.assert_preserved(output)
                path.unlink()
                # Empty hidden directories are also rejected, so remove fixture
                # parents that were introduced by this subcase.
                parent = path.parent
                while parent != self.root / "vendor":
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent

    def test_output_must_be_dist_child_and_never_outside_workspace(self):
        output = self.existing_output()
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("outside survives", encoding="utf-8")
        for candidate in ["dist", ".", "..", "dist/../outside", outside, self.root]:
            with self.subTest(output=str(candidate)):
                with self.assertRaises(web.BuildError):
                    web.build_web(candidate, workspace=self.root)
                self.assert_preserved(output)
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "outside survives")

    def test_nested_output_replaces_only_itself(self):
        default_output = self.existing_output()
        target = self.root / "dist/sites/review"
        target.mkdir(parents=True)
        (target / "stale-private.txt").write_text("old", encoding="utf-8")
        result = web.build_web("dist/sites/review", workspace=self.root)
        self.assertEqual(result, target)
        self.assertFalse((target / "stale-private.txt").exists())
        self.assertTrue((target / "index.html").is_file())
        self.assert_preserved(default_output)

    def test_copy_failure_keeps_old_output_and_removes_staging(self):
        output = self.existing_output()
        with mock.patch.object(web.shutil, "copyfile", side_effect=OSError("fixture disk failure")):
            with self.assertRaises(web.BuildError):
                web.build_web(workspace=self.root)
        self.assert_preserved(output)
        self.assertEqual(list((self.root / "dist").glob(".feelyreader-build-*")), [])

    def test_runtime_symlink_is_rejected_before_cleanup(self):
        output = self.existing_output()
        external = Path(self.temporary.name) / "external.js"
        external.write_text("private external content", encoding="utf-8")
        source = self.root / "e-app.js"
        source.unlink()
        self.symlink(external, source)
        with self.assertRaisesRegex(web.BuildError, "links|junctions"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_vendor_directory_symlink_is_rejected_before_cleanup(self):
        output = self.existing_output()
        external = Path(self.temporary.name) / "private-vendor"
        external.mkdir()
        self.symlink(external, self.root / "vendor/shortcut", directory=True)
        with self.assertRaisesRegex(web.BuildError, "links|junctions"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_output_symlink_never_removes_the_link_target(self):
        (self.root / "dist").mkdir()
        external = Path(self.temporary.name) / "private-output"
        external.mkdir()
        sentinel = external / "keep.txt"
        sentinel.write_text("outside survives", encoding="utf-8")
        self.symlink(external, self.root / "dist/redirect", directory=True)
        with self.assertRaisesRegex(web.BuildError, "links|junctions"):
            web.build_web("dist/redirect", workspace=self.root)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "outside survives")

    def test_symlink_inside_old_output_prevents_recursive_cleanup(self):
        output = self.existing_output()
        external = Path(self.temporary.name) / "private-child"
        external.mkdir()
        self.symlink(external, output / "redirect", directory=True)
        with self.assertRaisesRegex(web.BuildError, "link|junction"):
            web.build_web(workspace=self.root)
        self.assert_preserved(output)
        self.assertTrue(external.is_dir())

    def test_windows_reparse_point_metadata_is_rejected_without_symlink_privileges(self):
        output = self.existing_output()
        path = self.root / "e-app.js"
        real_lstat = Path.lstat

        def lstat(candidate, *args, **kwargs):
            info = real_lstat(candidate, *args, **kwargs)
            if candidate == path:
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_size=info.st_size,
                                       st_file_attributes=0x400)
            return info

        with mock.patch.object(Path, "lstat", lstat):
            with self.assertRaisesRegex(web.BuildError, "junctions"):
                web.build_web(workspace=self.root)
        self.assert_preserved(output)

    def test_cli_output_uses_the_same_safety_checks(self):
        with mock.patch.object(web, "WORKSPACE", self.root), redirect_stdout(io.StringIO()) as stream:
            self.assertEqual(web.main(["--output", "dist/preview"]), 0)
        self.assertIn("0.3.0", stream.getvalue())
        self.assertTrue((self.root / "dist/preview/manifest.json").is_file())
        with mock.patch.object(web, "WORKSPACE", self.root), redirect_stderr(io.StringIO()):
            self.assertEqual(web.main(["--output", "dist"]), 1)
        self.assertTrue((self.root / "dist/preview/manifest.json").is_file())


if __name__ == "__main__":
    unittest.main()
