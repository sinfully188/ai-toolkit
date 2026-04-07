import sqlite3
import tempfile
import unittest
from pathlib import Path

from toolkit.power_usage import PowerUsageTracker


def _create_settings_db(settings_db_path):
    with sqlite3.connect(settings_db_path) as conn:
        conn.execute("CREATE TABLE Settings (key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany(
            "INSERT INTO Settings(key, value) VALUES(?, ?)",
            [
                ("POWER_PRICE_PER_KWH", "2.0"),
                ("POWER_PRICE_CURRENCY", "USD"),
            ],
        )


def _create_broken_resume_log(log_db_path):
    with sqlite3.connect(log_db_path) as conn:
        conn.execute(
            """
            CREATE TABLE samples (
                timestamp REAL PRIMARY KEY,
                total_power_w REAL NOT NULL,
                energy_wh REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        conn.executemany(
            "INSERT INTO samples(timestamp, total_power_w, energy_wh) VALUES(?, ?, ?)",
            [
                (1.0, 100.0, 0.0),
                (2.0, 100.0, 10.0),
                (3.0, 100.0, 20.0),
                (4.0, 150.0, 0.0),
                (5.0, 150.0, 5.0),
            ],
        )
        conn.executemany(
            "INSERT INTO metadata(key, value) VALUES(?, ?)",
            [
                ("started_at", "1.0"),
                ("total_energy_wh", "5.0"),
                ("average_power_w", "150.0"),
                ("peak_power_w", "150.0"),
                ("sample_count", "2"),
                ("estimated_cost", "0.01"),
            ],
        )


class PowerUsageTrackerResumeTests(unittest.TestCase):
    def test_restore_existing_state_rebuilds_cumulative_energy_across_resumes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            save_root = tmp_path / "job-output"
            save_root.mkdir()
            settings_db_path = tmp_path / "aitk.db"
            _create_settings_db(str(settings_db_path))

            log_db_path = save_root / "power_log.db"
            _create_broken_resume_log(str(log_db_path))

            tracker = PowerUsageTracker(
                save_root=str(save_root),
                sqlite_db_path=str(settings_db_path),
            )

            tracker._init_db()
            tracker._restore_existing_state()

            self.assertEqual(tracker._sample_count, 5)
            self.assertEqual(tracker._sum_power_w, 600.0)
            self.assertEqual(tracker._peak_power_w, 150.0)
            self.assertEqual(tracker._cumulative_energy_wh, 25.0)
            self.assertEqual(tracker._started_at, 1.0)

            summary_rows = dict(tracker._summary_metadata_rows())
            self.assertEqual(float(summary_rows["average_power_w"]), 120.0)
            self.assertEqual(float(summary_rows["total_energy_wh"]), 25.0)
            self.assertEqual(float(summary_rows["estimated_cost"]), 0.05)


if __name__ == "__main__":
    unittest.main()