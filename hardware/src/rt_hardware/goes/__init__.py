"""GOES satellite downlink: pointing, CCSDS/LRIT decode chain, product store.

Everything in this package is pure Python and unit-testable without hardware.
The DSP front end (demodulation + Viterbi) lives in the GNU Radio subprocess
[rt_hardware.goes_pipeline]; this package picks up the decoded bitstream.
"""
