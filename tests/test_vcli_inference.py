import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "resources" / "ocr" / "vcli_inference.py"
spec = importlib.util.spec_from_file_location("vcli_inference", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeTokenizer:
    def encode(self, text, add_special_tokens=False):
        # 保守模拟：ASCII 每 4 字符约一个 token，非 ASCII 每字符一个 token。
        count = 0
        ascii_run = 0
        for char in text:
            if ord(char) < 128:
                ascii_run += 1
            else:
                count += (ascii_run + 3) // 4
                ascii_run = 0
                count += 1
        count += (ascii_run + 3) // 4
        return list(range(count))


class FakeProcessor:
    tokenizer = FakeTokenizer()


class MixContextTests(unittest.TestCase):
    def test_large_ocr_is_bounded_and_spatially_sampled(self):
        items = []
        for index in range(5000):
            row = index // 10
            col = index % 10
            items.append({
                "text": f"row {row} column {col} amount ${index * 17}",
                "bbox": [col * 100, row * 8, col * 100 + 90, row * 8 + 7],
                "type": "ui_text" if index % 11 == 0 else "text",
            })
        layout = {"img_size": [1000, 4000], "patterns": {"has_grid": True}}
        context, stats = module.build_bounded_ocr_context(
            FakeProcessor(), items, layout, 1000
        )
        self.assertIsNotNone(context)
        self.assertLessEqual(stats["injectedTokens"], 1000)
        self.assertTrue(stats["truncated"])
        self.assertGreater(stats["includedItems"], 0)
        self.assertLess(stats["includedItems"], stats["originalItems"])
        self.assertIn("@", context)
        self.assertIn("spatial-priority-token-budget-v1", stats["strategy"])

    def test_zero_budget_skips_ocr_injection_but_reports_stats(self):
        context, stats = module.build_bounded_ocr_context(
            FakeProcessor(), [{"text": "important", "bbox": [0, 0, 10, 10]}], None, 0
        )
        self.assertIsNone(context)
        self.assertEqual(stats["includedItems"], 0)
        self.assertEqual(stats["omittedItems"], 1)
        self.assertTrue(stats["truncated"])


class VlmPromptTests(unittest.TestCase):
    def test_vlm_prompt_appends_p_after_default_task(self):
        prompt = module.build_vlm_user_prompt("只列出主要按钮")
        self.assertTrue(prompt.startswith(module.VLM_DEFAULT_PROMPT))
        self.assertTrue(prompt.endswith("只列出主要按钮"))
        self.assertNotIn("<ocr-evidence>", prompt)

    def test_mix_prompt_places_ocr_before_p(self):
        ocr_context = "#0 @50,10,20,5 text 导出报表"
        prompt = module.build_vlm_user_prompt("判断批注要求", ocr_context)
        self.assertLess(prompt.index(ocr_context), prompt.index("判断批注要求"))
        self.assertIn("<ocr-evidence>", prompt)
        self.assertIn("</ocr-evidence>", prompt)

    def test_system_prompts_are_generic_and_forbid_uncertain_output(self):
        self.assertIn("禁止猜测", module.VLM_SYSTEM_PROMPT)
        self.assertIn("无法可靠确认的内容直接省略", module.VLM_SYSTEM_PROMPT)
        self.assertIn("OCR 结果为主要依据", module.MIX_SYSTEM_PROMPT)
        for customized_term in ("红色", "箭头", "圈选", "气泡", "网页"):
            self.assertNotIn(customized_term, module.VLM_SYSTEM_PROMPT)
            self.assertNotIn(customized_term, module.VLM_DEFAULT_PROMPT)

    def test_vlm_output_normalizes_bbox_and_keeps_all_records(self):
        records = module._normalize_vlm_records([
            {"role": "button", "text": "Export", "position": [100, 20, 200, 60]},
            {"text": "Export", "position": [100, 20, 200, 60]},
            {"text": "按钮需要调整", "position": [20, 10, 80, 30]},
            "not an object",
        ])
        self.assertEqual(records, [
            {"role": "button", "text": "Export", "position": [150, 40]},
            {"text": "Export", "position": [150, 40]},
            {"text": "按钮需要调整", "position": [50, 20]},
        ])


if __name__ == "__main__":
    unittest.main()
