import unittest
from datetime import datetime, timedelta, timezone

from tradepulse_quant.configuration import StrategyConfiguration
from tradepulse_quant.session_engine import (
    current_session_window,
    is_entry_permitted,
    is_session_active,
    normalize_to_ist,
    session_end_for,
    session_start_for,
    validate_session_boundaries,
)


class SessionEngineTests(unittest.TestCase):
    def setUp(self):
        self.config = StrategyConfiguration()

    def test_boundary_exact_times(self):
        checks = {
            "2026-09-12 09:14:59": ("PRE_OPEN", False),
            "2026-09-12 09:15:00": ("OPENING_RANGE", False),
            "2026-09-12 09:29:59": ("OPENING_RANGE", False),
            "2026-09-12 09:30:00": ("POST_OR_PRE_ENTRY", False),
            "2026-09-12 09:34:59": ("POST_OR_PRE_ENTRY", False),
            "2026-09-12 09:35:00": ("ENTRY_WINDOW", True),
            "2026-09-12 14:44:59": ("ENTRY_WINDOW", True),
            "2026-09-12 14:45:00": ("CLOSE_TO_SQUARE_OFF", False),
            "2026-09-12 15:14:59": ("CLOSE_TO_SQUARE_OFF", False),
            "2026-09-12 15:15:00": ("MANDATORY_SQUARE_OFF", False),
        }
        for text, (expected_phase, expected_entry) in checks.items():
            ts = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
            self.assertEqual(current_session_window(ts, self.config), expected_phase)
            self.assertEqual(is_entry_permitted(ts, self.config), expected_entry)
            expected_active = expected_phase not in {"PRE_OPEN", "MANDATORY_SQUARE_OFF"}
            self.assertEqual(is_session_active(ts, self.config), expected_active)

    def test_timezone_normalization_uses_ist(self):
        utc = datetime(2026, 9, 12, 9, 15, tzinfo=timezone.utc)
        ist = normalize_to_ist(utc)
        self.assertEqual(ist.tzinfo.utcoffset(ist), timedelta(hours=5, minutes=30))
        self.assertEqual(ist.time().hour, 14)
        self.assertEqual(ist.time().minute, 45)

    def test_session_boundaries_are_exact(self):
        ts = datetime(2026, 9, 12, 9, 35)
        ok, phase = validate_session_boundaries(ts, self.config)
        self.assertTrue(ok)
        self.assertEqual(phase, "ENTRY_WINDOW")

    def test_session_days_are_stable(self):
        ts = datetime(2026, 9, 12, 9, 15)
        self.assertEqual(session_start_for(ts).date().isoformat(), "2026-09-12")
        self.assertEqual(session_end_for(ts).date().isoformat(), "2026-09-12")


if __name__ == "__main__":
    unittest.main()
