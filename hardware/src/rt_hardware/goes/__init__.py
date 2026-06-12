"""GOES satellite downlink integration.

The receive chain is goestools (https://github.com/pietern/goestools):
`goesrecv` owns the SDR and decodes the downlink to VCDUs, `goesproc` turns
them into product files. This package holds the glue — goestools config
generation ([goestools]), a minimal nanomsg subscriber ([nanomsg]), the
product-directory index ([products]), geostationary look angles
([pointing]), and a synthetic backend for SDR-less development
([simulator]).
"""
