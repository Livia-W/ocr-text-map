"""Exercise publication against a temporary local bare remote, without network."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts import build_web, publish_pages as pages


class PagesPublishTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="feelyreader-publish-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()
        for relative in (*build_web.RUNTIME_ASSETS, *build_web.REQUIRED_VENDOR_ASSETS):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"" if relative == ".nojekyll" else b"runtime fixture\n")
        (self.root / "vendor/mediapipe/hands_solution_simd_wasm_bin.data").write_bytes(b"")
        (self.root / ".gitignore").write_text("dist/\noutputs/\n", encoding="utf-8")
        self.git = pages.Git(self.root)
        self.git.run(["init", "--initial-branch=main"])
        self.git.run(["config", "user.name", "Fixture"])
        self.git.run(["config", "user.email", "fixture@example.invalid"])
        self.git.run(["add", "."])
        self.git.run(["commit", "-m", "Source fixture"])
        self.bare = Path(self.temporary.name) / "remote.git"
        self.git.run(["init", "--bare", str(self.bare)])
        self.git.run(["remote", "add", "origin", str(self.bare)])
        self.output = build_web.build_web(workspace=self.root)

    def test_first_publish_and_update_preserve_source_and_fast_forward_pages(self):
        source = self.git.run(["rev-parse", "HEAD"]).stdout.strip()
        index = hashlib.sha256((self.root / ".git/index").read_bytes()).hexdigest()
        first = pages.publish_pages(workspace=self.root)
        self.assertEqual(self.git.run(["rev-parse", "HEAD"]).stdout.strip(), source)
        self.assertEqual(self.git.run(["symbolic-ref", "--short", "HEAD"]).stdout.strip(), b"main")
        self.assertEqual(hashlib.sha256((self.root / ".git/index").read_bytes()).hexdigest(), index)
        self.assertFalse(self.git.run(["status", "--porcelain"]).stdout.strip())
        self.git.run(["fetch", "origin", "gh-pages"])
        names = self.git.run(["ls-tree", "-r", "--name-only", first]).stdout.decode().splitlines()
        self.assertIn("manifest.json", names)
        self.assertIn("vendor/mediapipe/hands_solution_simd_wasm_bin.data", names)
        self.assertNotIn(".gitignore", names)
        self.assertIn(source, self.git.run(["show", "-s", "--format=%B", first]).stdout)
        second = pages.publish_pages(workspace=self.root)
        self.assertEqual(self.git.run(["show", "-s", "--format=%P", second]).stdout.strip().decode(), first)
        self.assertNotEqual(second, first)
        self.assertEqual(self.git.run(["rev-parse", "HEAD"]).stdout.strip(), source)

    def test_tampering_and_extra_private_files_are_rejected(self):
        (self.output / "app.js").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(pages.PublishError, "manifest"):
            pages.validate_build(workspace=self.root)
        build_web.build_web(workspace=self.root)
        (self.output / ".env").write_text("fixture", encoding="utf-8")
        with self.assertRaises(pages.PublishError):
            pages.validate_build(workspace=self.root)

    def test_dirty_source_is_rejected_before_git_publication(self):
        (self.root / "app.js").write_text("uncommitted", encoding="utf-8")
        with self.assertRaisesRegex(pages.PublishError, "Commit source"):
            pages.publish_pages(workspace=self.root, check_only=True)

    def test_manifest_cannot_smuggle_backend_files(self):
        manifest_path = self.output / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        backend = self.output / "server.py"
        backend.write_text("fixture backend", encoding="utf-8")
        manifest["files"].append({"path": "server.py", "bytes": backend.stat().st_size,
                                  "sha256": hashlib.sha256(backend.read_bytes()).hexdigest()})
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(pages.PublishError):
            pages.validate_build(workspace=self.root)


if __name__ == "__main__":
    unittest.main()
