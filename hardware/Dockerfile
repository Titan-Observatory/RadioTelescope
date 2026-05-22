FROM python:3.11-slim

# SoapySDR + Airspy driver come from apt; the Python bindings aren't on PyPI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3-soapysdr \
        soapysdr-module-airspy \
        libsoapysdr0.8 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-cache-dir .

EXPOSE 8001

CMD ["rt-hardware", "-c", "config.toml"]
