import os
import sqlite3
from typing import Dict, Optional


def read_power_usage_summary(log_file: str) -> Optional[Dict[str, object]]:
    if not os.path.exists(log_file):
        return None

    keys = [
        "average_power_w",
        "peak_power_w",
        "total_energy_wh",
        "estimated_cost",
        "sample_count",
        "currency",
        "final_status",
    ]

    try:
        with sqlite3.connect(log_file, timeout=30.0) as conn:
            cursor = conn.cursor()
            placeholders = ", ".join("?" for _ in keys)
            cursor.execute(
                f"SELECT key, value FROM metadata WHERE key IN ({placeholders})",
                keys,
            )
            rows = dict(cursor.fetchall())
    except sqlite3.Error:
        return None

    sample_count_raw = rows.get("sample_count", "")
    try:
        sample_count = int(sample_count_raw) if str(sample_count_raw).strip() != "" else 0
    except (TypeError, ValueError):
        sample_count = 0

    if sample_count <= 0:
        return None

    def _parse_float(key: str) -> Optional[float]:
        value = rows.get(key, "")
        try:
            return float(value) if str(value).strip() != "" else None
        except (TypeError, ValueError):
            return None

    currency = str(rows.get("currency", "") or "")
    final_status = str(rows.get("final_status", "") or "")

    return {
        "average_power_w": _parse_float("average_power_w") or 0.0,
        "peak_power_w": _parse_float("peak_power_w") or 0.0,
        "total_energy_wh": _parse_float("total_energy_wh") or 0.0,
        "estimated_cost": _parse_float("estimated_cost"),
        "sample_count": sample_count,
        "currency": currency or None,
        "final_status": final_status or None,
    }
