from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "apps" / "desktop" / "package.json"
BUILDER = ROOT / "electron-builder.yml"


class DesktopPackagingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.package = json.loads(PACKAGE.read_text(encoding="utf-8"))
        cls.scripts = cls.package.get("scripts", {})
        cls.builder = BUILDER.read_text(encoding="utf-8")

    def test_package_declares_supported_node_and_electron_targets(self) -> None:
        self.assertGreaterEqual(self.package["engines"]["node"], ">=22")
        self.assertEqual("dist-main/main/main.js", self.package["main"])
        self.assertIn("target: nsis", self.builder)
        self.assertIn("target: AppImage", self.builder)
        self.assertIn("publish: null", self.builder)

    def test_packaging_scripts_cover_build_and_each_declared_platform(self) -> None:
        self.assertIn("build", self.scripts)
        for platform in ("linux", "win", "dir"):
            script = self.scripts.get(f"package:{platform}") or self.scripts.get(f"dist:{platform}")
            self.assertIsNotNone(script, f"missing packaging script for {platform}")
            self.assertIn("build", script)

    def test_packaging_does_not_replace_runtime_entrypoint_with_source(self) -> None:
        self.assertEqual("dist-main/main/main.js", self.package["main"])

if __name__ == "__main__":
    unittest.main()
