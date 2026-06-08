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
        self._db_conn: Optional[sqlite3.Connection] = None
        self._db_lock = threading.RLock()

    def start(self) -> None:
        if not self._gpu_ids:
            return
        if not self._has_nvidia_smi():
            return

        os.makedirs(self.save_root, exist_ok=True)
        self._init_db()
        self._restore_existing_state()
        self._write_summary_metadata()
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
        self._close_db()
        self.enabled = False

    def _get_db_connection(self) -> sqlite3.Connection:
        with self._db_lock:
            if self._db_conn is None:
                conn = sqlite3.connect(
                    self.log_file,
                    timeout=30.0,
                    check_same_thread=False,
                )
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute("PRAGMA synchronous=NORMAL;")
                self._db_conn = conn
            return self._db_conn

    def _reset_db_connection(self) -> None:
        with self._db_lock:
            if self._db_conn is not None:
                try:
                    self._db_conn.close()
                except sqlite3.Error:
                    pass
                self._db_conn = None

    def _close_db(self) -> None:
        self._reset_db_connection()

    def _run_db_operation(self, operation, retry_on_open_error: bool = True):
        try:
            with self._db_lock:
                return operation(self._get_db_connection())
        except sqlite3.OperationalError as error:
            if retry_on_open_error and "unable to open database file" in str(error).lower():
                self._reset_db_connection()
                with self._db_lock:
                    return operation(self._get_db_connection())
            raise

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
        def _init(conn: sqlite3.Connection) -> None:
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
            conn.execute(
                "INSERT OR IGNORE INTO metadata(key, value) VALUES(?, ?);",
                ("started_at", str(self._started_at)),
            )
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                [
                    ("gpu_ids", ",".join(str(gpu_id) for gpu_id in self._gpu_ids)),
                    ("sample_interval_secs", str(self.sample_interval_secs)),
                    ("rate_per_kwh", "" if self._rate_per_kwh is None else str(self._rate_per_kwh)),
                    ("currency", self._currency),
                    ("ended_at", ""),
                    ("final_status", ""),
                ],
            )
            conn.commit()

        self._run_db_operation(_init)

    def _restore_existing_state(self) -> None:
        if not os.path.exists(self.log_file):
            return

        try:
            def _read_existing(conn: sqlite3.Connection):
                sample_totals = conn.execute(
                    "SELECT COUNT(*), COALESCE(SUM(total_power_w), 0.0), COALESCE(MAX(total_power_w), 0.0) FROM samples;"
                ).fetchone()
                energies = conn.execute(
                    "SELECT energy_wh FROM samples ORDER BY timestamp ASC;"
                ).fetchall()
                metadata_rows = dict(
                    conn.execute(
                        "SELECT key, value FROM metadata WHERE key IN (?, ?);",
                        ("started_at", "total_energy_wh"),
                    ).fetchall()
                )
                return sample_totals, energies, metadata_rows

            sample_totals, energies, metadata_rows = self._run_db_operation(_read_existing, retry_on_open_error=False)
            if sample_totals is None:
                sample_count = 0
                sum_power_w = 0.0
                peak_power_w = 0.0
            else:
                sample_count = int(sample_totals[0] or 0)
                sum_power_w = float(sample_totals[1] or 0.0)
                peak_power_w = float(sample_totals[2] or 0.0)
        except sqlite3.Error:
            return

        self._sample_count = sample_count
        self._sum_power_w = sum_power_w
        self._peak_power_w = peak_power_w
        self._cumulative_energy_wh = self._rebuild_cumulative_energy_wh(energies)

        if self._cumulative_energy_wh <= 0.0:
            try:
                metadata_total = float(str(metadata_rows.get("total_energy_wh", "") or "").strip())
            except (TypeError, ValueError):
                metadata_total = 0.0
            self._cumulative_energy_wh = max(metadata_total, 0.0)

        started_at_raw = str(metadata_rows.get("started_at", "") or "").strip()
        if started_at_raw:
            try:
                self._started_at = float(started_at_raw)
            except (TypeError, ValueError):
                pass

        self._last_sample_time = None

    def _rebuild_cumulative_energy_wh(self, energy_rows):
        completed_energy_wh = 0.0
        previous_energy_wh: Optional[float] = None

        for row in energy_rows:
            if not row:
                continue
            try:
                current_energy_wh = float(row[0])
            except (TypeError, ValueError):
                continue

            if previous_energy_wh is not None and current_energy_wh < previous_energy_wh:
                completed_energy_wh += previous_energy_wh

            previous_energy_wh = max(current_energy_wh, 0.0)

        if previous_energy_wh is None:
            return 0.0

        return completed_energy_wh + previous_energy_wh

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
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
            except sqlite3.Error as error:
                self._reset_db_connection()
                print(f"[AITK] Power tracker SQLite error: {error}")
            except Exception as error:
                print(f"[AITK] Power tracker error: {error}")

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
        def _write(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT OR REPLACE INTO samples(timestamp, total_power_w, energy_wh) VALUES(?, ?, ?);",
                (timestamp, total_power_w, self._cumulative_energy_wh),
            )
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                self._summary_metadata_rows(),
            )
            conn.commit()

        self._run_db_operation(_write)

    def _write_summary(self, final_status: str) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                self._summary_metadata_rows(final_status),
            )
            conn.commit()

        self._run_db_operation(_write)

    def _write_summary_metadata(self) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            conn.executemany(
                "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                self._summary_metadata_rows(),
            )
            conn.commit()

        self._run_db_operation(_write)

    def _summary_metadata_rows(self, final_status: Optional[str] = None):
        average_power_w = self._sum_power_w / self._sample_count if self._sample_count > 0 else 0.0
        total_cost = None
        if self._rate_per_kwh is not None:
            total_cost = (self._cumulative_energy_wh / 1000.0) * self._rate_per_kwh

        rows = [
            ("total_energy_wh", str(self._cumulative_energy_wh)),
            ("average_power_w", str(average_power_w)),
            ("peak_power_w", str(self._peak_power_w)),
            ("sample_count", str(self._sample_count)),
            ("estimated_cost", "" if total_cost is None else str(total_cost)),
        ]

        if final_status is not None:
            rows.extend([
                ("ended_at", "" if self._ended_at is None else str(self._ended_at)),
                ("final_status", final_status),
            ])

        return rows
