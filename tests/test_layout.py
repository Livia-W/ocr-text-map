import unittest

import numpy as np

from mobile_ocr.engine import Detection
from mobile_ocr.layout import analyze_layout


def line(text, x, y, w=180, h=24):
    return Detection(np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=float), text, .95)


class LayoutTests(unittest.TestCase):
    def test_full_width_heading_then_columns(self):
        items = [line("右二", 340, 130), line("左二", 30, 130),
                 line("标题", 30, 15, 490, 40), line("右一", 340, 90), line("左一", 30, 90)]
        ordered, blocks = analyze_layout(items, 600)
        self.assertEqual([d.text for d, _ in ordered], ["标题", "左一", "左二", "右一", "右二"])
        self.assertEqual(blocks[0]["type"], "heading")
        self.assertEqual(len(blocks), 3)
        self.assertEqual(blocks[2]["line_ids"], ["line-4", "line-5"])

    def test_merge_cjk_fragments_without_english_spaces(self):
        ordered, _ = analyze_layout([line("中文", 10, 10, 48), line("识别", 65, 10, 48)], 300)
        self.assertEqual([d.text for d, _ in ordered], ["中文识别"])

    def test_merge_latin_words_with_space(self):
        ordered, _ = analyze_layout([line("hello", 10, 10, 60), line("world", 76, 10, 60)], 300)
        self.assertEqual(ordered[0][0].text, "hello world")

    def test_jittered_detection_tops_preserve_left_to_right_order(self):
        ordered, _ = analyze_layout([line("识别", 65, 10, 48), line("中文", 10, 12, 48)], 300)
        self.assertEqual([d.text for d, _ in ordered], ["中文识别"])

    def test_wide_gutter_keeps_two_columns(self):
        ordered, blocks = analyze_layout([line("右", 300, 20, 60), line("左", 10, 20, 60)], 400)
        self.assertEqual([d.text for d, _ in ordered], ["左", "右"])
        self.assertEqual(len(blocks), 2)

    def test_empty(self):
        self.assertEqual(analyze_layout([], 500), ([], []))


if __name__ == "__main__":
    unittest.main()
