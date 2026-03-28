import os
import sqlite3
import subprocess
import threading
import time
from typing import List, Optional, Tuple


class PowerUsageTracker:
    def __init__(
        self,
        save_root: str,
        sqlite_db_path: Optional[str] = None,
        sample_interval_secs: float = 10.0,
    ) -> None:
        self.save_root = save_root
        self.sqlite_db_path = sqlite_db_path
        self.sample_interval_secs = max(float(sample_interval_secs), 1.0)
        self.log_file = os.path.join(save_root, "power_log.db")

        self.enabled = False
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._started_at = time.time()
        self._ended_at: Optional[float] = None

        self._gpu_ids = self._get_gpu_ids_from_env()
        self._rate_per_kwh, self._currency = self._load_pricing_settings()
        self._cumulative_energy_wh = 0.0
        self._sample_count = 0
        self._sum_power_w = 0.0
        self._peak_power_w = 0.0
        self._last_sample_time: Optional[float] = None

    def start(self) -> None:
        if not self._gpu_ids:
            return
        if not self._has_nvidia_smi():
            return

        os.makedirs(self.save_root, exist_ok=True)
        self._init_db()
        self.enabled = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self, final_status: str) -> None:
        if not self.enabled:
            return

        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(self.sample_interval_secs, 2.0) + 1.0)

        self._ended_at = time.time()
        self._write_summary(final_status)
        self.enabled = False

    def _get_gpu_ids_from_env(self) -> List[int]:
        raw_gpu_ids = os.environ.get("CUDA_VISIBLE_DEVICES", "").strip()
        if raw_gpu_ids == "":
            return []

        gpu_ids: List[int] = []
        for item in raw_gpu_ids.split(','):
            item = item.strip()
            if item == "":
                continue
            try:
                gpu_ids.append(int(item))
            except ValueError:
                continue
        return gpu_ids

    def _load_pricing_settings(self) -> Tuple[Optional[float], str]:
        if self.sqlite_db_path is None or not os.path.exists(self.sqlite_db_path):
            return None, ""

        try:
            with sqlite3.connect(self.sqlite_db_path, timeout=10.0) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT key, value FROM Settings WHERE key IN (?, ?)",
                    ("POWER_PRICE_PER_KWH", "POWER_PRICE_CURRENCY"),
                )
                rows = dict(cursor.fetchall())
        except sqlite3.Error:
            return None, ""

        rate_raw = rows.get("POWER_PRICE_PER_KWH", "")
        currency = rows.get("POWER_PRICE_CURRENCY", "")
        try:
            rate = float(rate_raw) if str(rate_raw).strip() != "" else None
        except (TypeError, ValueError):
            rate = None
        return rate, str(currency or "")

    def _has_nvidia_smi(self) -> bool:
        try:
            subprocess.run(
                ["nvidia-smi", "-L"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except Exception:
            return False

    def _init_db(self) -> None:
        with sqlite3.connect(self.log_file, timeout=30.0) as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS samples (
                    timestamp REAL PRIMARY KEY,
                    total_power_w REAL NOT NULL,
                    energy_wh REAL NOT NULL
                );
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                """
            )
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                [
                    ("gpu_ids", ",".join(str(gpu_id) for gpu_id in self._gpu_ids)),
                    ("sample_interval_secs", str(self.sample_interval_secs)),
                    ("started_at", str(self._started_at)),
                    ("rate_per_kwh", "" if self._rate_per_kwh is None else str(self._rate_per_kwh)),
                    ("currency", self._currency),
                ],
            )

    def _run(self) -> None:
        while not self._stop_event.is_set():
            now = time.time()
            total_power_w = self._read_total_power_w()
            if total_power_w is not None:
                if self._last_sample_time is not None:
                    elapsed_hours = max(now - self._last_sample_time, 0.0) / 3600.0
                    self._cumulative_energy_wh += total_power_w * elapsed_hours
                self._last_sample_time = now
                self._sample_count += 1
                self._sum_power_w += total_power_w
                self._peak_power_w = max(self._peak_power_w, total_power_w)
                self._write_sample(now, total_power_w)

            self._stop_event.wait(self.sample_interval_secs)

    def _read_total_power_w(self) -> Optional[float]:
        query = "index,power.draw"
        command = [
            "nvidia-smi",
            f"--query-gpu={query}",
            "--format=csv,noheader,nounits",
        ]
        try:
            result = subprocess.run(command, check=True, capture_output=True, text=True)
        except Exception:
            return None

        total_power_w = 0.0
        seen_gpu = False
        for line in result.stdout.strip().splitlines():
            parts = [part.strip() for part in line.split(',')]
            if len(parts) != 2:
                continue
            try:
                gpu_index = int(parts[0])
                power_draw = float(parts[1])
            except ValueError:
                continue
            if gpu_index in self._gpu_ids:
                total_power_w += power_draw
                seen_gpu = True
        if not seen_gpu:
            return None
        return total_power_w

    def _write_sample(self, timestamp: float, total_power_w: float) -> None:
        with sqlite3.connect(self.log_file, timeout=30.0) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO samples(timestamp, total_power_w, energy_wh) VALUES(?, ?, ?);",
                (timestamp, total_power_w, self._cumulative_energy_wh),
            )

    def _write_summary(self, final_status: str) -> None:
        average_power_w = self._sum_power_w / self._sample_count if self._sample_count > 0 else 0.0
        total_cost = None
        if self._rate_per_kwh is not None:
            total_cost = (self._cumulative_energy_wh / 1000.0) * self._rate_per_kwh

        with sqlite3.connect(self.log_file, timeout=30.0) as conn:
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                [
                    ("ended_at", "" if self._ended_at is None else str(self._ended_at)),
                    ("final_status", final_status),
                    ("total_energy_wh", str(self._cumulative_energy_wh)),
                    ("average_power_w", str(average_power_w)),
                    ("peak_power_w", str(self._peak_power_w)),
                    ("sample_count", str(self._sample_count)),
                    ("estimated_cost", "" if total_cost is None else str(total_cost)),
                ],
            )