from __future__ import annotations

import math

import katpoint

from rt_hardware.config import ObserverConfig

_C = 299_792_458.0


def make_antenna(cfg: ObserverConfig) -> katpoint.Antenna:
    # katpoint interprets float lat/lon as radians; strings are parsed as degrees.
    return katpoint.Antenna(
        cfg.name,
        str(cfg.latitude_deg),
        str(cfg.longitude_deg),
        cfg.altitude_m,
        cfg.dish_diameter_m,
    )


def altaz_to_radec(alt_deg: float, az_deg: float, antenna: katpoint.Antenna) -> tuple[float, float]:
    """Return (ra_deg, dec_deg) J2000 for the given Alt/Az at the current moment."""
    ts = katpoint.Timestamp()
    obs = antenna.observer
    obs.date = ts.to_ephem_date()
    ra_ephem, dec_ephem = obs.radec_of(math.radians(az_deg), math.radians(alt_deg))
    # ephem angles are plain radians; RA only *prints* as hours:minutes:seconds.
    return math.degrees(float(ra_ephem)), math.degrees(float(dec_ephem))


def radec_to_altaz(ra_deg: float, dec_deg: float, antenna: katpoint.Antenna) -> tuple[float, float]:
    """Return (alt_deg, az_deg) for the given RA/Dec J2000 at the current moment."""
    # katpoint parses colon-separated RA as hours but plain decimals as degrees,
    # so pass the RA through unchanged.
    target = katpoint.Target(f"target, radec, {ra_deg:.6f}, {dec_deg:.6f}")
    ts = katpoint.Timestamp()
    az_rad, el_rad = target.azel(ts, antenna)
    return math.degrees(el_rad), math.degrees(az_rad)


def compute_fwhm_deg(cfg: ObserverConfig) -> float:
    """Return beam FWHM in degrees from config override or dish+frequency."""
    if cfg.beam_fwhm_deg is not None:
        return cfg.beam_fwhm_deg
    wavelength = _C / cfg.observing_freq_hz
    return math.degrees(1.22 * wavelength / cfg.dish_diameter_m)
