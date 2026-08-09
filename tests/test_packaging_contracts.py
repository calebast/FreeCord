from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "apps" / "desktop" / "package.json"
BUILDER = ROOT / "electron-builder.yml"
VENMIC_NOTICE = ROOT / "docs" / "THIRD_PARTY_NOTICES.md"


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

    def test_linux_pipewire_runtime_is_bundled_without_its_build_toolchain(self) -> None:
        self.assertEqual("7.1.0", self.package["optionalDependencies"]["@vencord/venmic"])
        self.assertIn("node_modules/@vencord/venmic/prebuilds/venmic-addon-linux-x64/node-napi-v7.node", self.builder)
        self.assertIn("to: venmic.node", self.builder)
        self.assertIn("!node_modules/@vencord/venmic/**", self.builder)
        self.assertIn("!node_modules/cmake-js/**", self.builder)
        self.assertIn("venmic-MPL-2.0.txt", self.builder)
        self.assertIn("Mozilla Public License 2.0", VENMIC_NOTICE.read_text(encoding="utf-8"))

if __name__ == "__main__":
    unittest.main()
