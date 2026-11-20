"""Unit tests for the parts of ScenePack that don't need FFmpeg.  Run:  python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scenepack import engine, tv  # noqa: E402


class EpisodeNames(unittest.TestCase):
    def check(self, path, show, season, episode):
        e = tv.parse_episode(path)
        self.assertEqual((e["show"], e["season"], e["episode"]), (show, season, episode), path)

    def test_common_patterns(self):
        self.check("D:/TV/Breaking.Bad.S01E02.720p.WEB-DL.mkv", "Breaking Bad", 1, 2)
        self.check("D:/TV/Friends/1x07 The One with the Blackout.avi", "Friends", 1, 7)
        self.check("D:/TV/The Office/Season 3/05 - Initiation.mp4", "The Office", 3, 5)
        self.check("D:/Shows/Dark/Season 2/Episode 4.mkv", "Dark", 2, 4)

    def test_films_are_not_episodes(self):
        self.assertIsNone(tv.parse_episode("D:/Films/Avatar (2009).mkv")["season"])

    def test_codes(self):
        self.assertEqual(tv.episode_code(1, 2), "S01E02")
        self.assertEqual(tv.episode_code(0, 7), "E07")


class Naming(unittest.TestCase):
    def test_default_template(self):
        name = engine.clip_name("{name}_scene_{num}_{time}", {"name": "Avatar", "num": "012", "time": engine.stamp(754)})
        self.assertEqual(name, "Avatar_scene_012_00h12m34s")

    def test_names_stay_unique(self):
        self.assertIn("003", engine.clip_name("{show}{name}", {"name": "Film", "num": "003", "time": "t"}))

    def test_bad_templates(self):
        self.assertTrue(engine.template_problem("{oops}"))
        self.assertTrue(engine.template_problem("{name"))
        self.assertEqual(engine.template_problem("{code} {name} {time}"), "")

    def test_no_illegal_characters(self):
        self.assertNotRegex(engine.clip_name("{name}", {"name": 'a:b/c?"d', "num": "1", "time": "t"}), r'[:/?"]')


class SceneMaths(unittest.TestCase):
    def test_cuts_and_scenes(self):
        times = [i / 25 for i in range(200)]
        scores = [0.0] * 200
        for i in (50, 100, 150):
            scores[i] = 0.6
        cuts = engine.pick_cuts(times, scores, 0.3)
        self.assertEqual(cuts, [2.0, 4.0, 6.0])
        self.assertEqual(engine.build_scenes(cuts, 8.0, 25, 0.5), [[0.0, 2.0], [2.0, 4.0], [4.0, 6.0], [6.0, 8.0]])

    def test_short_scenes_merge(self):
        self.assertEqual(engine.build_scenes([1.0, 1.2, 5.0], 10.0, 25, 0.5), [[0.0, 1.2], [1.2, 5.0], [5.0, 10.0]])

    def test_picking_respects_skips(self):
        scenes = [[i + 1, i * 10.0, i * 10.0 + 3 + (i * 7) % 9] for i in range(40)]
        for mode in ("spread", "longest", "random"):
            picked = engine.pick_scenes(scenes, 400, {"count": 4, "mode": mode, "min_len": 2, "skip_start": 60,
                                                      "skip_end": 60}, "seed")
            self.assertEqual(len(picked), 4, mode)
            self.assertTrue(all(60 <= x[1] and x[2] <= 340 for x in picked), mode)
            self.assertEqual(picked, sorted(picked, key=lambda x: x[1]), mode)

    def test_random_is_repeatable(self):
        scenes = [[i + 1, i * 5.0, i * 5.0 + 4] for i in range(30)]
        pick = {"count": 5, "mode": "random"}
        self.assertEqual(engine.pick_scenes(scenes, 150, pick, "ep1"), engine.pick_scenes(scenes, 150, pick, "ep1"))


if __name__ == "__main__":
    unittest.main()
