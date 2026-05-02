from __future__ import annotations

import os
import shutil
from pathlib import Path

from radiotelescope.models.state import HostStats


def read_host_stats() -> HostStats:
    total_mb, available_mb, used_percent = _memory_stats()
    disk_total_gb, disk_free_gb, disk_used_percent = _disk_stats()
    load = _load_average()

    return HostStats(
        cpu_temp_c=_cpu_temp_c(),
        load_1m=load[0],
        load_5m=load[1],
        load_15m=load[2],
        cpu_count=os.cpu_count(),
        memory_total_mb=total_mb,
        memory_available_mb=available_mb,
        memory_used_percent=used_percent,
        disk_total_gb=disk_total_gb,
        disk_free_gb=disk_free_gb,
        disk_used_percent=disk_used_percent,
        uptime_s=_uptime_s(),
    )


def _cpu_temp_c() -> float | None:
    paths = [
        Path("/sys/class/thermal/thermal_zone0/temp"),
        Path("/sys/class/hwmon/hwmon0/temp1_input"),
    ]
    for path in paths:
        try:
            raw = path.read_text(encoding="utf-8").strip()
            if raw:
                value = float(raw)
                return round(value / 1000 if value > 200 else value, 1)
        except (OSError, ValueError):
            pass
    return None


def _load_average() -> tuple[float | None, float | None, float | None]:
    try:
        one, five, fifteen = os.getloadavg()
        return round(one, 2), round(five, 2), round(fifteen, 2)
    except (AttributeError, OSError):
        return None, None, None


def _memory_stats() -> tuple[float | None, float | None, float | None]:
    meminfo = _read_meminfo()
    total_kb = meminfo.get("MemTotal")
    available_kb = meminfo.get("MemAvailable")
    if total_kb is None or available_kb is None:
        return None, None, None

    total_mb = total_kb / 1024
    available_mb = available_kb / 1024
    used_percent = (1 - available_kb / total_kb) * 100
    return round(total_mb, 1), round(available_mb, 1), round(used_percent, 1)


def _read_meminfo() -> dict[str, float]:
    values: dict[str, float] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, rest = line.split(":", 1)
            values[key] = float(rest.strip().split()[0])
    except (OSError, ValueError, IndexError):
        pass
    return values


def _disk_stats() -> tuple[float | None, float | None, float | None]:
    try:
        usage = shutil.disk_usage("/")
    except OSError:
        return None, None, None

    total_gb = usage.total / 1024**3
    free_gb = usage.free / 1024**3
    used_percent = (usage.used / usage.total) * 100 if usage.total else 0
    return round(total_gb, 1), round(free_gb, 1), round(used_percent, 1)


def _uptime_s() -> float | None:
    try:
        raw = Path("/proc/uptime").read_text(encoding="utf-8").split()[0]
        return round(float(raw), 1)
    except (OSError, ValueError, IndexError):
        return None
