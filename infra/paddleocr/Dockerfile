FROM python:3.11.18-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 libgl1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ocr
COPY requirements.lock ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock \
    && python -m pip check
COPY models.json download_models.py ./
RUN python download_models.py
COPY engine.py cli.py verify_cases.py ./
ENV HOME=/tmp PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 GLOG_minloglevel=3
USER 10001:10001
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=5s", "80s", "python", "/opt/ocr/cli.py"]
CMD ["--self-test"]
